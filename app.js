require("dotenv").config();
const express = require("express");
const multer = require("multer");
const pdf = require("pdf-parse");
const mammoth = require("mammoth");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.use(express.json({ limit: "1mb" }));

const clip = (s, n = 12000) => String(s || "").slice(0, n);

// Calls Groq and returns parsed JSON. The API key never leaves the server.
async function llm(system, user) {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing in .env");
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system + " Respond with ONLY valid JSON." },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error("AI provider error " + r.status);
  const data = await r.json();
  return JSON.parse(data.choices[0].message.content);
}

// 1) File -> text (PDF, DOCX, TXT)
app.post("/api/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const name = req.file.originalname.toLowerCase();
    let text = "";
    if (name.endsWith(".pdf")) text = (await pdf(req.file.buffer)).text;
    else if (name.endsWith(".docx")) text = (await mammoth.extractRawText({ buffer: req.file.buffer })).value;
    else if (name.endsWith(".txt")) text = req.file.buffer.toString("utf8");
    else return res.status(400).json({ error: "Use a PDF, DOCX or TXT file" });
    res.json({ text: text.trim() });
  } catch (e) {
    res.status(500).json({ error: "Could not read that file" });
  }
});

// 2) Resume vs JD gap analysis
app.post("/api/analyze", async (req, res) => {
  try {
    const out = await llm(
      'You are an expert recruiter. Compare the resume to the job description. Return {"matchScore":0-100,"missingSkills":[strings],"strongMatches":[strings],"bulletRewrites":[{"original":"an actual resume bullet","suggested":"a stronger rewrite aligned to the JD, with a measurable result"}]} with 2-3 rewrites. Never invent employers or facts.',
      `RESUME:\n${clip(req.body.resume)}\n\nJOB DESCRIPTION:\n${clip(req.body.jd)}`
    );
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3) Interview questions (hard + easier variant used when hesitation is detected)
app.post("/api/questions", async (req, res) => {
  try {
    const out = await llm(
      'Write 3 behavioral/technical interview questions tailored to this resume and job. For each give a normal version and an easier, more open version on the same theme. Return {"questions":[{"hard":"","easy":""}]}.',
      `RESUME:\n${clip(req.body.resume, 6000)}\n\nJOB DESCRIPTION:\n${clip(req.body.jd, 6000)}`
    );
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 4) Teach It Back: planted weak answer with a specific, deliberate flaw.
// Round 1 (mapped to Q2 of the mock interview) is always metric-free.
// Round 2 (mapped to Q3 of the mock interview) always hides the candidate's personal contribution.
app.post("/api/plant", async (req, res) => {
  try {
    const { flawType, targetAnswer } = req.body;
    const isMetric = flawType === "metric";
    const flawInstruction = isMetric
      ? 'The flaw MUST be that the answer has no measurable outcome or number of any kind — no percentages, counts, dollar amounts, or time saved. It should only make vague claims like "it went well" or "the team was happy with it".'
      : 'The flaw MUST be that the answer never states what the candidate personally did — it should only use "we"/"the team" and never "I", so the individual\'s own contribution is invisible.';
    const flawLabel = isMetric ? "no measurable outcome" : 'no personal contribution — says "we" instead of "I"';
    const out = await llm(
      `You are writing a short, realistic, mediocre 2-3 sentence interview answer to plant in a "teach it back" exercise, so the candidate can practice spotting a flaw in someone else's answer. ${flawInstruction} Write it as an answer to a DIFFERENT interview question than any context given, in a similar theme or domain so it feels personal to the candidate. Return {"flaw":"${flawLabel}","plantedAnswer":"","hint":"one sentence telling the user this answer mirrors a pattern in their own answers, without naming the flaw"}.`,
      `CANDIDATE'S OWN ANSWER TO MATCH IN THEME (do not copy it, do not reuse its exact wording):\n${clip(targetAnswer, 1500)}`
    );
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 5) Teach It Back: did the user's critique catch the flaw?
app.post("/api/critique", async (req, res) => {
  try {
    const { planted, flaw, critique } = req.body;
    const out = await llm(
      'A user critiqued a planted weak interview answer. Decide if the critique identifies the actual flaw. Return {"caught":true|false,"feedback":"1-2 encouraging, specific sentences explaining what was caught or missed"}.',
      `PLANTED ANSWER: ${clip(planted, 2000)}\nACTUAL FLAW: ${clip(flaw, 300)}\nUSER CRITIQUE: ${clip(critique, 2000)}`
    );
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 6) ATS compatibility check (feedback page)
app.post("/api/ats", async (req, res) => {
  try {
    const out = await llm(
      'You are an ATS (Applicant Tracking System) parsing expert. Given plain-text resume content, assess how well it would parse and rank in a typical ATS. Check for: standard section headers (Experience, Education, Skills), presence of contact info, signs the source layout relies on tables/columns/graphics (irregular spacing, missing words, broken lines), consistent date formats, reasonable length, and no unusual symbols. Return {"atsScore":0-100,"issues":[{"issue":"short label","severity":"high|medium|low","fix":"one concrete fix"}],"strengths":[string]} with at most 6 issues, ranked by severity, most severe first. Base this only on what is in the text, never invent facts about the candidate.',
      `RESUME TEXT (as an ATS would extract it):\n${clip(req.body.resume)}`
    );
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 7) Personalized learning resources for missing skills (feedback page)
app.post("/api/resources", async (req, res) => {
  try {
    const missing = (req.body.missingSkills || []).slice(0, 6);
    if (!missing.length) return res.json({ resources: [] });
    const out = await llm(
      'You are a career coach. For each missing skill listed, suggest one focused, well-known way to close that specific gap (a named learning platform, official certification path, or curriculum type — e.g. "official AWS Cloud Practitioner learning path", "freeCodeCamp GraphQL curriculum", "Coursera Google Data Analytics Certificate"). Tie the reason to the job description when relevant. Do not invent specific URLs, course IDs, prices, or completion times. Return {"resources":[{"skill":"","resource":"","why":"one short sentence"}]}, exactly one entry per skill given, same order as given.',
      `MISSING SKILLS:\n${missing.join(", ")}\n\nJOB DESCRIPTION:\n${clip(req.body.jd, 4000)}`
    );
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Demo helper: write a plausible interview answer to whatever question is currently shown,
// tailored to the resume/JD, so a "fill demo answer" button stays genuinely adaptive.
app.post("/api/demo-answer", async (req, res) => {
  try {
    const { question, resume, jd } = req.body;
    const out = await llm(
      'Write a strong, specific, first-person interview answer (4-6 sentences, STAR-style: situation, action, measurable result) to the given interview question, as if spoken by the candidate whose resume is provided. Base it loosely on real-sounding details from the resume. Return {"answer":""}.',
      `QUESTION: ${clip(question, 500)}\nRESUME:\n${clip(resume, 6000)}\n\nJOB DESCRIPTION:\n${clip(jd, 4000)}`
    );
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Demo helper: write a corrected version of the planted weak answer, removing its specific flaw.
app.post("/api/demo-fix", async (req, res) => {
  try {
    const { planted, flaw } = req.body;
    const out = await llm(
      'Rewrite the given weak interview answer so it no longer has the stated flaw, keeping it realistic and first-person, 3-5 sentences. Return {"fixed":""}.',
      `WEAK ANSWER: ${clip(planted, 2000)}\nFLAW TO FIX: ${clip(flaw, 300)}`
    );
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Frontend (served at "/") ----------
const PAGE_TOP = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PrepPilot — Own the interview</title>
<style>
:root{--bg:#FFFFFF;--card:#F3F4F6;--blue:#3B82F6;--bright:#1D4ED8;--text:#000000;--mut:#4B5563;--ok:#059669;--warn:#D97706;--bad:#DC2626}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}
section{display:none}section.on{display:block}
h1{font-size:clamp(2rem,7vw,3.4rem);line-height:1.1;margin:.3em 0}h2{margin:.2em 0 .3em}
.acc{color:var(--bright)}.mut{color:var(--mut)}
.card{background:var(--card);border-radius:18px;padding:18px;margin:14px 0;box-shadow:0 6px 24px #0004}
.btn{background:var(--blue);color:#fff;border:0;border-radius:12px;min-height:44px;padding:0 22px;font-size:1rem;font-weight:600;cursor:pointer;margin:4px 6px 4px 0}
.btn:hover{background:var(--bright)}.btn:disabled{opacity:.4;cursor:not-allowed}.btn.o{background:transparent;border:1px solid var(--mut);color:var(--text)}
textarea{width:100%;min-height:140px;background:#FFFFFF;color:#000000;border:1px solid #D1D5DB;border-radius:12px;padding:12px;font:inherit;resize:vertical}
input[type=file]{color:var(--mut);margin:6px 0;max-width:100%}
.grid{display:grid;gap:14px;grid-template-columns:1fr}@media(min-width:720px){.grid{grid-template-columns:1fr 1fr}}
.pill{display:inline-block;padding:5px 12px;border-radius:99px;margin:4px 4px 0 0;font-size:.9rem}
.pill.w{background:#fbbf2426;color:var(--warn)}.pill.g{background:#34d39926;color:var(--ok)}.pill.b{background:#3b82f626;color:var(--bright)}
.bar{height:10px;background:var(--bg);border-radius:9px;overflow:hidden}.bar i{display:block;height:100%;background:var(--blue)}
.score{font-size:3.4rem;font-weight:800}
.spin{width:46px;height:46px;border:4px solid var(--card);border-top-color:var(--bright);border-radius:50%;animation:s 1s linear infinite;margin:60px auto 20px}@keyframes s{to{transform:rotate(360deg)}}
.mic{width:88px;height:88px;border-radius:50%;border:0;background:var(--blue);color:#fff;font-size:2rem;cursor:pointer;display:block;margin:12px auto}
.mic.live{background:var(--bad);animation:p 1.2s infinite}@keyframes p{0%{box-shadow:0 0 0 0 #f8717188}100%{box-shadow:0 0 0 22px #f8717100}}
.badge{display:none;background:#fbbf2426;color:var(--warn);padding:6px 12px;border-radius:99px;font-size:.85rem;float:right}
.ba{border-left:3px solid var(--blue);padding-left:12px;margin:10px 0}
.res{padding:10px 14px;border-radius:10px;margin-top:10px;display:none}.res.ok{background:#34d39922}.res.no{background:#f8717122}
</style></head><body><main>

<section id="s0" class="on" style="text-align:center;padding-top:8vh">
<div class="mut">✦ PrepPilot</div>
<h1>Land the role.<br><span class="acc">Own the interview.</span></h1>
<p class="mut">Resume gap analysis, a voice mock interview that adapts when you hesitate, and Teach It Back — where you coach a weak answer and fix your own.</p>
<button class="btn" onclick="go(1)">Upload resume &amp; get started →</button>
</section>

<section id="s1">
<h2>Upload your resume and job description</h2>
<p class="mut">Upload a PDF, DOCX or TXT (up to 10MB) or paste the text.</p>
<div class="grid">
<div class="card"><b>Resume</b><br><input type="file" accept=".pdf,.docx,.txt" onchange="up(this,'#rt')"><textarea id="rt" placeholder="Resume text…"></textarea></div>
<div class="card"><b>Job description</b><br><input type="file" accept=".pdf,.docx,.txt" onchange="up(this,'#jt')"><textarea id="jt" placeholder="Job description text…"></textarea></div></div>
<button class="btn o" onclick="sample()">Load sample</button>
<button class="btn" onclick="analyze()">Analyze &amp; Continue →</button>
</section>

<section id="s2">
<div id="load" style="text-align:center"><div class="spin"></div><h2>Analyzing your resume…</h2><p class="mut">Preparing your personalized interview insights.</p></div>
<div id="out" style="display:none">
<h2>Your Resume Analysis</h2>
<div class="card"><span class="mut">Resume–JD Match Score</span><div class="score" id="sc"></div><div class="bar"><i id="scb"></i></div></div>
<div class="grid"><div class="card"><b>Missing skills</b><div id="ms"></div></div><div class="card"><b>Strong matches</b><div id="sm"></div></div></div>
<div class="card"><b>Suggested bullet rewrites</b><div id="rw"></div></div>
<button class="btn" id="ci" onclick="startInt()">Continue to Mock Interview →</button></div>
</section>

<section id="s3">
<span class="badge" id="bd">Adjusting question difficulty</span>
<div class="mut" id="qn"></div><h2>Mock Interview</h2>
<div class="card"><div id="q" style="font-size:1.2rem"></div></div>
<button class="mic" id="mic" onclick="toggleMic()" aria-label="Toggle microphone">🎙</button>
<p class="mut" id="mst" style="text-align:center">Tap to answer out loud — or just type below.</p>
<textarea id="tr" placeholder="Live transcript appears here (editable)…"></textarea>
<p><button class="btn o" onclick="fillDemoAnswer()">⚡ Fill demo answer</button></p>
<p><button class="btn" id="nx" onclick="nextQ()" disabled>Next question →</button></p>
</section>

<section id="s4">
<div class="mut">TEACH IT BACK</div><h2>Coach this answer</h2>
<div class="mut" id="tRound"></div>
<div id="tload" class="mut">Preparing an answer for you to coach…</div>
<div id="tbody" style="display:none">
<p class="mut" id="tip"></p>
<div class="card"><i id="pl"></i></div>
<b>What's wrong with this answer?</b>
<textarea id="cr" placeholder="Write your critique…"></textarea>
<p><button class="btn o" onclick="fillDemoCritique()">⚡ Fill demo critique</button></p>
<button class="btn" id="cb" onclick="checkCrit()">Check my critique</button>
<div class="res" id="cres"></div>
<div id="fix" style="display:none"><h3>Now fix it yourself</h3><textarea id="fx" placeholder="Rewrite the answer so it's strong…"></textarea>
<p><button class="btn o" onclick="fillDemoFix()">⚡ Fill demo fix</button></p>
<button class="btn" onclick="finish()">Done — apply to my answer</button></div>
<div class="card" id="loop" style="display:none"><b>Loop closed</b><p id="lp"></p><div class="ba" id="own"></div>
<button class="btn" onclick="renderFeedback()">See my feedback summary →</button></div>
</div>
</section>

<section id="s5">
<h2>Your Interview Feedback</h2>
<p class="mut">A summary of this session — resume fit, interview confidence, and Teach It Back.</p>
<div class="grid">
<div class="card"><b>Resume–JD match</b><div class="score" id="fSc" style="font-size:2.2rem"></div><div class="bar"><i id="fScb"></i></div></div>
<div class="card"><b>Communication &amp; confidence</b><div class="score" id="fConf" style="font-size:2.2rem"></div><p class="mut" id="fConfNote"></p></div>
</div>
<div class="card"><b>ATS compatibility</b>
<div id="fAtsLoad" class="mut">Checking how this resume would parse in an ATS…</div>
<div id="fAtsBody" style="display:none">
<div class="score" id="fAtsSc" style="font-size:2.2rem"></div><div class="bar"><i id="fAtsScb"></i></div>
<div id="fAtsIssues"></div>
</div></div>
<div class="card"><b>Teach It Back</b><p id="fTeach"></p></div>
<div class="card"><b>Suggested next steps</b><div id="fRes"></div></div>
<div class="card"><b>Personalized learning resources</b>
<div id="fLearnLoad" class="mut">Finding resources for your skill gaps…</div>
<div id="fLearn" style="display:none"></div>
</div>
<button class="btn o" onclick="go(0)">Start over</button>
</section>
</main>
`;

// Browser code: written as a normal function so it stays readable, then sent to the browser as a script.
function client() {
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const go=n=>{document.querySelectorAll('section').forEach((e,i)=>e.classList.toggle('on',i===n));scrollTo(0,0)};
async function api(path,body){
    const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||'Request failed');return d;
}
async function up(inp,target){
    const f=inp.files[0];if(!f)return;
    const fd=new FormData();fd.append('file',f);
    try{const r=await fetch('/api/extract',{method:'POST',body:fd});const d=await r.json();
     if(!r.ok)throw new Error(d.error);$(target).value=d.text}
    catch(e){alert(e.message||'Upload failed')}
}
function sample(){
    $('#rt').value=`Product Manager, Nimbus Retail (2022-Present)
Led the redesign of the checkout flow, increasing conversion by 18% over two quarters.
Defined and prioritized a quarterly product roadmap based on customer interviews.
Partnered with engineering to ship a saved-cart feature used by 40,000+ users.
Ran weekly stakeholder syncs with design and marketing to align release timelines.
Skills: Product Strategy, Roadmapping, User Research, Figma, JIRA, SQL (basic), Agile`;
    $('#jt').value=`Senior Product Manager, Orbit Health
Own the product roadmap for the patient engagement platform.
Design and analyze A/B tests (Optimizely or similar).
Write SQL queries to analyze usage data independently.
Build dashboards in Looker or Mixpanel.
Present roadmap reviews to stakeholders. Mentor junior PMs. HIPAA familiarity is a plus.`;
}

/* ---------- Analysis ---------- */
async function analyze(){
    const resume=$('#rt').value.trim(),jd=$('#jt').value.trim();
    if(!resume||!jd){alert('Add both a resume and a job description.');return}

    go(2);$('#load').style.display='';$('#out').style.display='none';
    try{
     const d=await api('/api/analyze',{resume,jd});
     const sc=Math.max(0,Math.min(100,Math.round(d.matchScore||0)));
     lastScore=sc;lastMissing=d.missingSkills||[];lastStrong=d.strongMatches||[];

$('#sc').textContent=sc+'%';$('#scb').style.width=sc+'%';
     $('#ms').innerHTML=(d.missingSkills||[]).map(k=>`<span class="pill w">${esc(k)}</span>`).join('')||'<span class="mut">None 🎉</span>';
     $('#sm').innerHTML=(d.strongMatches||[]).map(k=>`<span class="pill g">${esc(k)}</span>`).join('')||'<span class="mut">None found</span>';
     $('#rw').innerHTML=(d.bulletRewrites||[]).map(b=>`<div class="ba"><span class="mut">Original:</span> ${esc(b.original)}<br><span class="acc">Suggested:</span> ${esc(b.suggested)}</div>`).join('');

$('#load').style.display='none';$('#out').style.display='';
    }catch(e){alert('Analysis failed: '+e.message);go(1)}
}

/* ---------- Mock interview + hesitation detection ---------- */
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
let Q=[['Tell me about a time you made a difficult decision with incomplete data.','Tell me about a project you are proud of.'],
['Describe a conflict with a stakeholder and how you handled it.','Tell me about a time you worked with a teammate.'],['How do you prioritize a roadmap?','What does a good product look like to you?']];
let qi=0,easy=false,rec,live=false,last=0,fill=0,ans=[],timer,struggleCount=0,struggledThisQ=false,lastFinalText='';
let lastScore=0,lastMissing=[],lastStrong=[];
async function startInt(){

$('#ci').disabled=true;$('#ci').textContent='Preparing questions…';
    try{const d=await api('/api/questions',{resume:$('#rt').value,jd:$('#jt').value});

if(Array.isArray(d.questions)&&d.questions.length)Q=d.questions.map(x=>[x.hard,x.easy||x.hard])}catch(_){}

$('#ci').disabled=false;$('#ci').textContent='Continue to Mock Interview →';
    qi=0;ans=[];easy=false;struggleCount=0;showQ();go(3);
}
function showQ(){$('#qn').textContent=`Question ${qi+1} of ${Q.length}`;$('#q').textContent=Q[qi][easy?1:0];$('#tr').value='';$('#nx').disabled=true;$('#bd').style.display=easy?'inline-block':'none';fill=0;struggledThisQ=false;lastFinalText=''}
function struggle(){if(!struggledThisQ){struggledThisQ=true;struggleCount++}if(!easy){easy=true;$('#bd').style.display='inline-block'}}
function toggleMic(){
    if(live){stop();return}
    if(!SR){$('#mst').textContent='Speech recognition needs Chrome — type your answer instead.';return}
    try{
     lastFinalText='';
     rec=new SR();rec.continuous=true;rec.interimResults=true;
     rec.onresult=e=>{last=Date.now();for(let i=e.resultIndex;i<e.results.length;i++)if(e.results[i].isFinal){
       const t=e.results[i][0].transcript.trim();
       if(t && t!==lastFinalText){
           $('#tr').value+=t+'\n';$('#nx').disabled=false;
           fill+=(t.match(/\b(um|uh|like|you know|sort of|kind of)\b/gi)||[]).length;if(fill>4)struggle();
           lastFinalText=t;
       }
     }};
     rec.onend=()=>{lastFinalText='';if(live)try{rec.start()}catch(_){}};
     rec.onerror=e=>{if(e.error==='not-allowed'){$('#mst').textContent='Mic blocked — allow access or type your answer.';stop()}};

rec.start();live=true;last=Date.now();$('#mic').classList.add('live');$('#mst').textContent='Listening…';
     timer=setInterval(()=>{if(live&&Date.now()-last>3000)struggle()},500);
    }catch(_){$('#mst').textContent='Could not start the mic — type your answer.'}
}
function stop(){live=false;try{rec&&rec.stop()}catch(_){}clearInterval(timer);$('#mic').classList.remove('live');$('#mst').textContent='Tap to answer out loud — or just type below.';$('#nx').disabled=!$('#tr').value.trim()}
$('#tr').addEventListener('input',()=>{$('#nx').disabled=!$('#tr').value.trim()});
async function fillDemoAnswer(){
    const btn=event.target;btn.disabled=true;btn.textContent='Writing…';
    const question=Q[qi][easy?1:0];
    try{
        const d=await api('/api/demo-answer',{question,resume:$('#rt').value,jd:$('#jt').value});
        if(!d.answer)throw 0;
        $('#tr').value=d.answer;
    }catch(_){
        $('#tr').value="In my last role, I noticed our team was missing a clear milestone because two stakeholders had conflicting priorities. I set up a short working session, mapped out both requests against our quarterly goals, and proposed a phased plan that addressed the urgent need first while committing to a clear timeline for the rest. As a result, we shipped the first phase two weeks early and the stakeholders stayed aligned for the rest of the project.";
    }
    btn.disabled=false;btn.textContent='⚡ Fill demo answer';
    $('#nx').disabled=false;
}
function nextQ(){if(live)stop();ans[qi]=$('#tr').value.trim();qi++;if(qi<Q.length)showQ();else startTeach()}

/* ---------- Teach It Back ---------- */
// Fixed mapping, no longer inferred from the user's own answers:
// round 0 -> mirrors Q2 (index 1), always a metric-free planted answer.
// round 1 -> mirrors Q3 (index 2), always a planted answer with no personal contribution ("we" not "I").
let planted='',flawDesc='',caught=false;
let teachRound=0,TEACH_ROUNDS=2,usedFlaws=[],caughtCount=0;
const LOCAL={
    metric:{flaw:'no measurable outcome',plantedAnswer:'"We worked on a new onboarding flow and it went really well. Users liked it and the team was happy with the outcome."',hint:'This answer mirrors a pattern in your own answers.',re:/metric|number|measur|quantif|result|data|%|percent|impact|outcome|specific/i},
    own:{flaw:'says "we" instead of what the candidate personally did',plantedAnswer:'"We decided to change the roadmap and we shipped it together. We felt it was the right call for the team."',hint:'This answer mirrors a pattern in your own answers.',re:/\bwe\b|\bi\b|you|own|role|contribut|personal|responsib/i}
};
let localKey='metric';
async function startTeach(){
    teachRound=0;usedFlaws=[];caughtCount=0;
    go(4);await loadTeachRound();
}
async function loadTeachRound(){

TEACH_ROUNDS=2;
    $('#tRound').textContent=`Round ${teachRound+1} of ${TEACH_ROUNDS}`;

$('#tload').style.display='';$('#tbody').style.display='none';

$('#cr').value='';$('#fx').value='';$('#cres').style.display='none';$('#fix').style.display='none';$('#loop').style.display='none';

    // Round 0 always targets Q2 (index 1) and plants a metric-free answer.
    // Round 1 always targets Q3 (index 2) and plants a personal-contribution-free answer.
    const targetIdx=teachRound===0?1:2;
    localKey=teachRound===0?'metric':'own';
    const targetAnswer=ans[targetIdx]||ans.find(x=>x)||'';

    let d;
    try{d=await api('/api/plant',{flawType:localKey,targetAnswer});if(!d.plantedAnswer)throw 0}catch(_){d=LOCAL[localKey]}
    planted=d.plantedAnswer;flawDesc=d.flaw;

$('#pl').textContent=planted;$('#tip').textContent=d.hint||'';
$('#tload').style.display='none';$('#tbody').style.display='';
}
async function checkCrit(){
    const t=$('#cr').value.trim();if(!t)return;
    $('#cb').disabled=true;let d;
    try{d=await api('/api/critique',{planted,flaw:flawDesc,critique:t});if(typeof d.caught!=='boolean')throw 0}
    catch(_){const ok=LOCAL[localKey].re.test(t);d={caught:ok,feedback:ok?'You spotted the core flaw.':'The real flaw: '+flawDesc+'.'}}

$('#cb').disabled=false;caught=d.caught;if(caught)caughtCount++;
    const r=$('#cres');r.style.display='block';r.className='res '+(caught?'ok':'no');
    r.textContent=(caught?'✅ Caught it — ':'⚠️ Missed it — ')+(d.feedback||'');
    $('#fix').style.display='block';
}
function fillDemoCritique(){
    const t=$('#cr');
    t.value=`This answer misses the mark on: ${flawDesc || 'a specific, checkable detail'}. A stronger answer would fix that directly instead of staying vague.`;
}
async function fillDemoFix(){
    const btn=event.target;btn.disabled=true;btn.textContent='Writing…';
    try{
        const d=await api('/api/demo-fix',{planted,flaw:flawDesc});
        if(!d.fixed)throw 0;
        $('#fx').value=d.fixed;
    }catch(_){
        $('#fx').value="I led the redesign of our onboarding flow after noticing a drop-off in week-one signups. I proposed simplifying the first three steps, worked with design on a lighter version, and ran an A/B test. The result was a 22% increase in users completing onboarding within the first week.";
    }
    btn.disabled=false;btn.textContent='⚡ Fill demo fix';
}
function finish(){
    usedFlaws.push(localKey);
    const ownIdx=teachRound===0?1:2;
    const own=ans[ownIdx]||ans.find(x=>x)||'(no answer recorded)';
    $('#lp').textContent=(caught?'You caught the flaw here — ':'You missed it here — ')+'your own answers show the same pattern. Apply your rewrite to yours:';
    $('#own').innerHTML=`<span class="mut">Your Q${ownIdx+1} answer:</span> `+esc(own)+'<br><span class="acc">Your fix:</span> '+esc($('#fx').value||'(write a rewrite above)');
    const loopBtn=document.querySelector('#loop .btn');
    const hasMore=teachRound+1<TEACH_ROUNDS;
    loopBtn.textContent=hasMore?'Next planted answer →':'See my feedback summary →';
    loopBtn.onclick=hasMore?nextTeachRound:renderFeedback;

$('#loop').style.display='block';$('#loop').scrollIntoView({behavior:'smooth'});
}
function nextTeachRound(){teachRound++;loadTeachRound()}

/* ---------- Feedback summary ---------- */
function renderFeedback(){

$('#fSc').textContent=lastScore+'%';$('#fScb').style.width=lastScore+'%';
    const total=Q.length||1,confPct=Math.max(0,Math.round(100*(total-struggleCount)/total));
    $('#fConf').textContent=confPct+'%';
    $('#fConfNote').textContent=struggleCount===0
     ? 'No hesitation detected — answers were steady throughout.'
     : `Hesitation detected on ${struggleCount} of ${total} question${total===1?'':'s'} (long pauses or filler words) — the interview adjusted to easier questions when this happened.`;
    $('#fTeach').innerHTML=`You caught ${caughtCount} of ${TEACH_ROUNDS} planted flaw${TEACH_ROUNDS===1?'':'s'} across Teach It Back rounds.`
     +'<br><span class="mut">Most recent flaw practiced:</span> '+esc(flawDesc||'—');
    const tips=lastMissing.slice(0,4).map(k=>`<div class="ba">Practice or brush up on <b>${esc(k)}</b> — this was missing against the job description.</div>`).join('');
    $('#fRes').innerHTML=tips||'<span class="mut">No major resume gaps found — focus on interview delivery and Teach It Back instead.</span>';
    go(5);
    loadAts();
    loadResources();
}

/* ---------- ATS compatibility (feedback page) ---------- */
async function loadAts(){
    $('#fAtsLoad').style.display='';$('#fAtsBody').style.display='none';
    try{
        const d=await api('/api/ats',{resume:$('#rt').value});
        const score=Math.max(0,Math.min(100,Math.round(d.atsScore||0)));
        $('#fAtsSc').textContent=score+'%';$('#fAtsScb').style.width=score+'%';
        $('#fAtsIssues').innerHTML=(d.issues||[]).map(x=>{
            const cls=x.severity==='high'?'w':x.severity==='low'?'g':'b';
            return `<div class="ba"><span class="pill ${cls}">${esc(x.severity||'note')}</span> <b>${esc(x.issue)}</b><br><span class="acc">Fix:</span> ${esc(x.fix||'')}</div>`;
        }).join('')||'<span class="mut">No major ATS issues found — this resume should parse cleanly.</span>';
        $('#fAtsLoad').style.display='none';$('#fAtsBody').style.display='';
    }catch(e){
        $('#fAtsLoad').textContent='Could not check ATS compatibility right now.';
    }
}

/* ---------- Personalized learning resources (feedback page) ---------- */
async function loadResources(){
    $('#fLearnLoad').style.display='';$('#fLearn').style.display='none';
    if(!lastMissing.length){
        $('#fLearnLoad').textContent='No skill gaps found against this job description — nothing to recommend right now.';
        return;
    }
    try{
        const d=await api('/api/resources',{missingSkills:lastMissing,jd:$('#jt').value});
        $('#fLearn').innerHTML=(d.resources||[]).map(r=>`<div class="ba"><b>${esc(r.skill)}</b><br>${esc(r.resource)}<br><span class="mut">${esc(r.why||'')}</span></div>`).join('')||'<span class="mut">No specific resources available right now.</span>';
        $('#fLearnLoad').style.display='none';$('#fLearn').style.display='';
    }catch(e){
        $('#fLearnLoad').textContent='Could not load learning resources right now.';
    }
}
}

app.get("/", (req, res) => {
    const src = client.toString();
    const body = src.slice(src.indexOf("{") + 1, src.lastIndexOf("}"));
    res.type("html").send(PAGE_TOP + "<script>" + body + "</script></body></html>");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`PrepPilot running on http://localhost:${port}`));

export const activationHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="description" content="Turn one GitHub Issue into a governed, reviewable Draft PR with explicit approval and read-back evidence.">
  <title>Start with Foursday</title>
  <style nonce="__NONCE__">
    :root{--ink:#14201b;--muted:#5f6f67;--paper:#fffdf8;--canvas:#f3f0e8;--line:#d9d7cc;--green:#155f49;--green-2:#0d4636;--mint:#dcebe3;--amber:#82500b;--red:#9e3c32;--shadow:0 24px 70px rgba(38,52,45,.10);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink)}button,input,textarea,select{font:inherit}button{cursor:pointer}.shell{min-height:100vh;display:grid;grid-template-columns:minmax(280px,.72fr) minmax(520px,1.28fr)}.story{background:var(--ink);color:#f8f6ef;padding:40px clamp(28px,5vw,76px);display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}.story:after{content:"";position:absolute;width:360px;height:360px;border:1px solid #ffffff18;border-radius:50%;right:-190px;bottom:14%;box-shadow:0 0 0 65px #ffffff08,0 0 0 130px #ffffff05}.brand{font-size:15px;font-weight:760;letter-spacing:.04em}.eyebrow{color:#a9cabb;text-transform:uppercase;letter-spacing:.14em;font-size:11px;font-weight:750}.main .eyebrow{color:var(--green)}.story h1{font-size:clamp(42px,5vw,76px);line-height:.96;letter-spacing:-.055em;margin:16px 0 22px;max-width:650px}.story p{font-size:17px;line-height:1.6;color:#cbd4cf;max-width:560px}.trust{display:grid;gap:13px;position:relative;z-index:1}.trust div{border-top:1px solid #ffffff22;padding-top:13px;display:flex;justify-content:space-between;gap:20px}.trust span{color:#9fb0a8;font-size:13px}.trust strong{font-size:13px;text-align:right}.main{padding:36px clamp(24px,5vw,72px) 80px;max-width:980px;width:100%;margin:auto}.topline{display:flex;justify-content:space-between;align-items:center;margin-bottom:38px;gap:18px}.top-actions{display:flex;align-items:center;gap:9px}.language-switch{display:flex;gap:3px;padding:3px;border:1px solid var(--line);border-radius:99px;background:var(--paper)}.language-switch a{color:var(--muted);text-decoration:none;font-size:12px;font-weight:760;padding:5px 8px;border-radius:99px}.language-switch a.active{color:white;background:var(--green)}.mode{font-size:12px;color:var(--green);font-weight:740;background:var(--mint);padding:8px 11px;border-radius:99px}.step{display:flex;gap:18px;padding:26px 0;border-top:1px solid var(--line)}.step:first-of-type{border-top:0}.number{width:32px;height:32px;border:1px solid var(--line);border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:800;flex:0 0 auto;background:var(--paper)}.step-body{flex:1;min-width:0}.step h2{font-size:20px;margin:2px 0 6px;letter-spacing:-.02em}.hint{color:var(--muted);line-height:1.55;margin:0 0 18px}.fields{display:grid;grid-template-columns:1fr 1fr;gap:14px}.field{display:block;min-width:0}.field.wide{grid-column:1/-1}.field span{display:block;font-size:12px;color:var(--muted);font-weight:700;margin:0 0 7px}.field input,.field textarea,.field select{width:100%;min-width:0;border:1px solid var(--line);background:var(--paper);border-radius:10px;padding:12px 13px;color:var(--ink);outline:none;transition:border-color .15s,box-shadow .15s}.field textarea{min-height:88px;resize:vertical}.field input:focus,.field textarea:focus,.field select:focus{border-color:var(--green);box-shadow:0 0 0 3px #155f4920}.action{margin-left:50px;background:var(--green);color:white;border:0;border-radius:11px;padding:14px 20px;font-weight:760;box-shadow:0 8px 22px #155f4929}.action:hover{background:var(--green-2)}.action:disabled{opacity:.55;cursor:wait}.secondary{display:inline-flex;align-items:center;background:transparent;color:var(--green);border:1px solid #155f4960;border-radius:10px;padding:11px 14px;font-weight:740;text-decoration:none}.danger{color:var(--red);border-color:#9e3c3255}.error{margin:16px 0 0 50px;color:var(--red);font-weight:650}.hidden{display:none}.result{margin-top:30px;background:var(--paper);border:1px solid var(--line);box-shadow:var(--shadow);border-radius:18px;overflow:hidden}.result-head{padding:24px 26px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:16px}.result-head h2{margin:0 0 6px;font-size:24px}.result-body{padding:8px 26px 28px}.tag{display:inline-flex;align-items:center;height:27px;padding:0 9px;border-radius:99px;font-size:11px;font-weight:780}.tag.safe{background:var(--mint);color:var(--green)}.tag.locked{background:#f7ead7;color:var(--amber)}.hash{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;color:var(--muted)}.hash-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.hash-row .secondary{padding:6px 11px;font-size:12px}.plan-step{display:grid;grid-template-columns:34px 1fr auto;gap:12px;align-items:start;padding:17px 0;border-bottom:1px solid var(--line)}.plan-step:last-child{border-bottom:0}.plan-step strong{display:block;margin-bottom:4px}.plan-step p{margin:0;color:var(--muted);font-size:13px;line-height:1.5}.footnote{background:#f1eee5;padding:16px 18px;border-radius:11px;color:var(--muted);font-size:13px;line-height:1.55;margin-top:18px}.execution{margin-top:18px;border:1px solid #155f4933;border-radius:13px;padding:18px;background:#f5f8f4}.execution h3{margin:0 0 7px;font-size:17px}.execution p{color:var(--muted);font-size:13px;line-height:1.55}.execution-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:14px}.approval-fields{display:grid;grid-template-columns:1fr 140px;gap:12px;margin-top:14px}.approval-check{display:flex;gap:9px;align-items:flex-start;margin-top:13px;font-size:13px;line-height:1.45}.approval-check input{margin-top:3px}.evidence-row{display:flex;justify-content:space-between;gap:14px;border-top:1px solid var(--line);padding:11px 0;font-size:13px}.evidence-row span{color:var(--muted)}@media(max-width:820px){.shell{display:block}.story{min-height:auto;padding:28px 24px 34px}.story h1{font-size:48px}.story-copy{margin:64px 0}.main{padding:28px 20px 60px}.fields,.approval-fields{grid-template-columns:1fr}.field.wide{grid-column:auto}.action,.error{margin-left:0}.step{gap:12px}.result-head{display:block}.result-head .tag{margin-top:12px}.plan-step{grid-template-columns:32px minmax(0,1fr)}.plan-step>.tag{grid-column:2;justify-self:start}.result-body{padding:8px 18px 24px}.evidence-row{display:block}.evidence-row span{display:block;margin-top:4px}}@media(max-width:420px){.story h1{font-size:43px}.story-copy{margin:58px 0}.topline{align-items:flex-start}.top-actions{flex-direction:column;align-items:flex-end}.mode{white-space:nowrap}.step h2{font-size:19px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
  </style>
</head>
<body>
<div class="shell">
  <aside class="story">
    <div class="brand">Foursday</div>
    <div class="story-copy"><div class="eyebrow">Your first safe handoff</div><h1>Give your coding agent one real job.</h1><p>Turn a GitHub issue into a project-bound, reviewable delivery plan. Foursday shows every capability, risk level, and expected proof before anything can run.</p></div>
    <div class="trust"><div><span>Accounts required</span><strong>None for preview</strong></div><div><span>Preview storage</span><strong>None</strong></div><div><span>Execution</span><strong>Local SQLite · exact approval</strong></div></div>
  </aside>
  <main class="main">
    <div class="topline"><div><div class="eyebrow">10-minute setup</div><strong>GitHub delivery preview</strong></div><div class="top-actions"><nav class="language-switch" aria-label="Language"><a class="active" aria-current="page" href="?lang=en">EN</a><a href="?lang=zh">中文</a></nav><span class="mode">Local · no writes</span></div></div>
    <form id="activation">
      <section class="step"><div class="number">1</div><div class="step-body"><h2>Bind a project</h2><p class="hint">The root must be a real Git repository. This preview does not save a project manifest.</p><div id="pilot-setup" class="execution __PILOT_SETUP_VISIBILITY__"><h3>Prepare the official v0.5 pilot in this page</h3><p>The reviewed command fixed a candidate commit. First run the read-only readiness check: it reports only whether GitHub CLI authentication and supported agent runtimes are available. After your separate confirmation, Foursday can create or reuse your personal GitHub fork, clone it into <code>~/FoursdayPilot/</code>, bind the credential-free upstream, check out that exact commit, and install lockfile dependencies without lifecycle scripts. It will not run a model, create a delivery branch, push, open a PR, merge, or deploy.</p><p class="hash" id="pilot-source-sha">Candidate __PILOT_SOURCE_SHA__</p><div class="execution-actions"><button class="secondary" id="check-pilot-readiness" type="button">Check pilot readiness</button></div><div id="pilot-readiness-results" class="footnote hidden"></div><p id="pilot-readiness-status" class="hint" role="status" aria-live="polite" aria-atomic="true"></p><label class="approval-check"><input id="pilot-confirm" type="checkbox"> <span>I authorize creation or reuse of my personal Foursday fork, a local clone in the fixed pilot directory, and a locked dependency install.</span></label><div class="execution-actions"><button class="secondary" id="prepare-pilot" type="button">Prepare my pilot fork</button></div><p id="pilot-status" class="hint" role="status" aria-live="polite" aria-atomic="true"></p></div><div class="fields"><label class="field"><span>Project ID</span><input name="projectId" value="my-project" pattern="[a-z0-9][a-z0-9_\\-]{1,63}" required></label><label class="field"><span>Project name</span><input name="projectName" value="My project" required></label><label class="field wide"><span>Git repository root</span><input id="root" name="rootDirectory" required></label><label class="field"><span>Local owner ID</span><input name="requesterId" value="local-owner" required></label><label class="field"><span>Agent runtime</span><select name="runtime"><option value="demo">Deterministic preview</option><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="openai-compatible">OpenAI-compatible</option></select></label></div></div></section>
      <section class="step"><div class="number">2</div><div class="step-body"><h2>Choose the work</h2><p class="hint">Use a public GitHub issue URL or one you are already authorized to access. The preview does not call GitHub.</p><div class="fields"><label class="field wide"><span>GitHub issue URL</span><input name="issueUrl" type="url" placeholder="https://github.com/owner/repository/issues/123" required></label><label class="field wide"><span>Confirmed change request</span><textarea name="changeRequest" placeholder="Describe the smallest acceptable change and its boundary." required></textarea></label><label class="field"><span>Base branch</span><input name="baseBranch" value="main" required></label><label class="field"><span>Registered test command ID</span><input name="testCommandId" value="check" required></label><label class="field wide"><span>Draft PR title</span><input name="prTitle" placeholder="fix: describe the verified change" required></label></div></div></section>
      <section class="step"><div class="number">3</div><div class="step-body"><h2>Review before authority</h2><p class="hint">Foursday will build the same immutable five-step recipe used by the governed runtime. External effects remain disabled; local preparation remains approval-bound. Downloaded evidence retains Issue and PR URLs, plan and commit evidence, and confirmed outcomes while omitting local paths, remotes, tokens, credentials, and model output.</p></div></section>
      <button class="action" type="submit">Build my reviewable plan</button><p id="error" class="error hidden" role="alert"></p>
    </form>
    <section id="result" class="result hidden" aria-live="polite"></section>
  </main>
</div>
<script nonce="__NONCE__">
const form=document.getElementById('activation');
const result=document.getElementById('result');
const errorBox=document.getElementById('error');
const button=form.querySelector('button[type=submit]');
const actionToken='__ACTION_TOKEN__';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const human=value=>String(value??'').replaceAll('_',' ');
const suggestedPilotAlias='tester-'+Array.from(crypto.getRandomValues(new Uint8Array(6)),byte=>byte.toString(16).padStart(2,'0')).join('');
let environment={executionAvailable:false};let currentInput=null;let currentSession=null;
const api=async(path,body,timeout=15000)=>{const headers={'content-type':'application/json'};if(path.startsWith('/api/sessions')||path==='/api/pilot-workspace'||path==='/api/pilot-task-draft'||path==='/api/readiness')headers['x-foursday-action-token']=actionToken;const response=await fetch(path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});const data=await response.json();if(!response.ok)throw new Error(data.error||'Request failed');return data};
const downloadEvidence=async()=>{if(!currentSession?.sessionId)throw new Error('No completed activation session is available');const response=await fetch('/api/sessions/'+encodeURIComponent(currentSession.sessionId)+'/evidence',{headers:{'x-foursday-action-token':actionToken},signal:AbortSignal.timeout(15000)});if(!response.ok){const data=await response.json();throw new Error(data.error||'Evidence download failed')}const blob=await response.blob();const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='foursday-evidence-'+currentSession.plan.planHash.slice(0,12)+'.json';document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(link.href)};
const copyText=async value=>{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);return}const area=document.createElement('textarea');area.value=value;area.readOnly=true;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();const copied=document.execCommand('copy');area.remove();if(!copied)throw new Error('Clipboard is unavailable')};
const copyPublicProof=async()=>{if(!currentSession?.sessionId)throw new Error('No confirmed activation session is available');const response=await fetch('/api/sessions/'+encodeURIComponent(currentSession.sessionId)+'/public-proof',{headers:{'x-foursday-action-token':actionToken},signal:AbortSignal.timeout(15000)});const data=await response.json();if(!response.ok)throw new Error(data.error||'Public proof export failed');await copyText(data.markdown)};
fetch('/api/environment').then(response=>response.json()).then(data=>{environment=data;const root=document.getElementById('root');root.value=data.pilotWorkspaceAvailable?'':data.workingDirectory||'';if(data.pilotWorkspaceAvailable){document.getElementById('pilot-setup').classList.remove('hidden');document.getElementById('pilot-source-sha').textContent='Candidate '+data.pilotSourceSha}}).catch(()=>{});
document.getElementById('check-pilot-readiness').addEventListener('click',async event=>{
  const target=event.currentTarget;const status=document.getElementById('pilot-readiness-status');const results=document.getElementById('pilot-readiness-results');target.disabled=true;status.textContent='Checking GitHub authentication and local agent runtimes...';
  try{
    const readiness=await api('/api/readiness',{});const rows=[['GitHub CLI',readiness.github.cliAvailable],['GitHub authenticated',readiness.github.authenticated],['Codex',readiness.runtimes.codex],['Claude Code',readiness.runtimes.claudeCode],['OpenAI-compatible',readiness.runtimes.openAiCompatible]];results.innerHTML=rows.map(([label,ready])=>'<div class="evidence-row"><strong>'+esc(label)+'</strong><span>'+esc(ready?'Ready':'Not ready')+'</span></div>').join('');results.classList.remove('hidden');
    if(readiness.runtimes.openAiCompatibleConfigurationError)results.insertAdjacentHTML('beforeend','<p>OpenAI-compatible configuration is incomplete or invalid; configure BASE_URL, API_KEY, and MODEL together before restart.</p>');
    if(readiness.setupCheckin){
      if(readiness.supportReport&&!readiness.readyForGovernedExecution)results.insertAdjacentHTML('beforeend','<div class="execution"><h3>Blocked? Share only a bounded readiness report</h3><p>Copy the fixed candidate and readiness booleans without paths, usernames, private repository details, logs, model output, or credentials. Review it before posting.</p><div class="execution-actions"><button class="secondary" id="copy-readiness-support" type="button">Copy privacy-safe readiness report</button><a class="secondary" href="'+esc(readiness.supportReport.issueUrl)+'" target="_blank" rel="noopener noreferrer">Open bug report</a></div><p id="readiness-support-status" class="hint" role="status" aria-live="polite" aria-atomic="true"></p></div>');
      results.insertAdjacentHTML('beforeend','<div class="execution-actions"><button class="secondary" id="copy-setup-checkin" type="button">Copy setup check-in</button><a class="secondary" href="'+esc(readiness.setupCheckin.issueUrl)+'" target="_blank" rel="noopener noreferrer">Open setup Issue #50</a></div><p id="setup-checkin-status" class="hint" role="status" aria-live="polite" aria-atomic="true"></p><div class="execution"><h3>Create your unique pilot task</h3><p>Issue #49 is only for intake and feedback. A random pseudonymous alias is created in this browser so you can start immediately without waiting for a maintainer. You may replace it with another <code>tester-</code> alias before creating the task.</p><div class="execution-actions"><label class="field"><span>Self-chosen pilot alias</span><input id="pilot-participant-alias" value="'+esc(suggestedPilotAlias)+'" pattern="tester-[a-z0-9][a-z0-9\\\\-]{2,23}" inputmode="text" autocomplete="off"></label><button class="secondary" id="prepare-pilot-task-link" type="button">Prepare unique task link</button></div><div id="pilot-task-action" class="execution-actions hidden"></div><p id="pilot-task-status" class="hint" role="status" aria-live="polite" aria-atomic="true"></p></div>');
      const supportButton=document.getElementById('copy-readiness-support');if(supportButton)supportButton.addEventListener('click',async supportEvent=>{const copyButton=supportEvent.currentTarget;const supportStatus=document.getElementById('readiness-support-status');copyButton.disabled=true;supportStatus.textContent='Copying bounded readiness report...';try{await copyText(readiness.supportReport.markdown);supportStatus.textContent='Readiness report copied. Review it, add only a redacted symptom, then post voluntarily.'}catch{supportStatus.textContent='Readiness report copy failed. Open the bug form and enter only redacted details.'}finally{copyButton.disabled=false}});
      document.getElementById('copy-setup-checkin').addEventListener('click',async copyEvent=>{const copyButton=copyEvent.currentTarget;const checkinStatus=document.getElementById('setup-checkin-status');copyButton.disabled=true;checkinStatus.textContent='Copying privacy-safe setup check-in...';try{await copyText(readiness.setupCheckin.markdown);checkinStatus.textContent='Setup check-in copied. Choose your platform, add time and one friction point, then post voluntarily.'}catch{checkinStatus.textContent='Setup check-in copy failed. Open Issue #50 and use its bounded template.'}finally{copyButton.disabled=false}});
      document.getElementById('prepare-pilot-task-link').addEventListener('click',async taskEvent=>{const taskButton=taskEvent.currentTarget;const taskStatus=document.getElementById('pilot-task-status');const taskAction=document.getElementById('pilot-task-action');taskButton.disabled=true;taskStatus.textContent='Preparing a bounded task draft locally...';try{const task=await api('/api/pilot-task-draft',{participantAlias:document.getElementById('pilot-participant-alias').value});form.elements.namedItem('changeRequest').value=task.changeRequest;form.elements.namedItem('baseBranch').value=task.baseBranch;form.elements.namedItem('testCommandId').value=task.testCommandId;form.elements.namedItem('prTitle').value=task.prTitle;taskAction.innerHTML='<a class="secondary" href="'+esc(task.newIssueUrl)+'" target="_blank" rel="noopener noreferrer">Open my unique task Issue</a>';taskAction.classList.remove('hidden');taskStatus.textContent='Task draft ready. Review and submit it on GitHub, then paste the new Issue URL below. No Issue has been created yet.'}catch{taskAction.classList.add('hidden');taskAction.innerHTML='';taskStatus.textContent='Use tester- followed by 3-24 lowercase letters, numbers, or hyphens.'}finally{taskButton.disabled=false}});
    }
    status.textContent=readiness.readyForGovernedExecution?'Ready for fork preparation and governed execution.':readiness.readyForPilotPreparation?'Fork preparation is ready. Install or configure at least one supported agent runtime before execution.':'Install and authenticate GitHub CLI before preparing the pilot fork.';
  }catch{status.textContent='Readiness check failed safely. No fork, branch, push, or PR was created.'}finally{target.disabled=false}
});
document.getElementById('prepare-pilot').addEventListener('click',async event=>{const target=event.currentTarget;const status=document.getElementById('pilot-status');if(!document.getElementById('pilot-confirm').checked){status.textContent='Confirm the fork, clone, and locked dependency install first.';return}const checkinButton=document.getElementById('copy-setup-checkin');if(checkinButton){checkinButton.disabled=true;checkinButton.textContent='Setup changed after pilot preparation'}target.disabled=true;status.textContent='Preparing the authorized fork and local checkout...';try{const prepared=await api('/api/pilot-workspace',{confirmForkAndClone:true},600000);document.getElementById('root').value=prepared.rootDirectory;status.textContent='Pilot workspace ready. Review the repository root and continue to build the plan.'}catch{status.textContent='Pilot preparation failed. Check GitHub CLI login and retry; no delivery branch or PR was created.'}finally{target.disabled=false}});
function executionOffer(data){if(data.runtime==='demo')return '<div class="execution"><h3>Ready to use a real agent?</h3><p>Choose Codex, Claude Code, or a configured compatible provider to create an approval-bound execution session.</p></div>';if(!environment.executionAvailable)return '<div class="execution"><h3>Execution is unavailable in this package mode</h3><p>The five-step plan remains reviewable, but this server exposes no execution coordinator.</p></div>';return '<div class="execution" id="execution-panel"><h3>Continue to a real Draft PR</h3><p>The next action writes an encrypted local SQLite session and rechecks the clean Git repository, fixed npm test script, origin remote, agent executable, and GitHub CLI. It still does not call the model or GitHub. Execution requires a second, exact-hash approval.</p><div class="execution-actions"><button class="secondary" type="button" data-action="create-session">Create local execution session</button></div></div>'}
form.addEventListener('submit',async event=>{event.preventDefault();const originalLabel=button.textContent;button.disabled=true;button.textContent='Building the plan…';errorBox.classList.add('hidden');try{const body=Object.fromEntries(new FormData(form));const data=await api('/api/preview',body);currentInput=body;currentSession=null;const displaySteps=data.presentation?.steps||data.plan.steps;const steps=displaySteps.map((step,index)=>{const cap=data.capabilities.find(item=>item.name===step.capability);return '<div class="plan-step"><div class="number">'+(index+1)+'</div><div><strong>'+esc(step.title||step.description)+'</strong><p>'+esc(step.evidence||step.expectedEvidence)+'</p></div><span class="tag '+(cap.configuredMode==='disabled'?'locked':'safe')+'">'+esc(cap.level)+' · '+esc(human(cap.configuredMode))+'</span></div>'}).join('');const blocked=data.presentation?.blockedCapabilities?.map(human).join(', ')||'one or more required capabilities';result.innerHTML='<div class="result-head"><div><h2>Safe preview complete</h2><div class="hash-row"><div class="hash" id="plan-hash">Plan '+esc(data.planHash)+'</div><button class="secondary" type="button" data-action="copy-plan-hash" data-hash="'+esc(data.planHash)+'">Copy plan hash</button></div><p id="plan-hash-status" class="hint" role="status" aria-live="polite" aria-atomic="true"></p></div><span class="tag safe">0 external systems touched</span></div><div class="result-body">'+steps+'<div class="footnote"><strong>Why execution is blocked:</strong> Configure explicit authority for '+esc(blocked)+'. This is an honest activation preview—not a claim that code, a branch, or a pull request already exists.</div>'+executionOffer(data)+'</div>';result.classList.remove('hidden');result.scrollIntoView({behavior:'smooth',block:'start'})}catch(error){errorBox.textContent=error.message;errorBox.classList.remove('hidden')}finally{button.disabled=false;button.textContent=originalLabel}});
result.addEventListener('click',async event=>{const target=event.target.closest('[data-action]');if(!target)return;const panel=document.getElementById('execution-panel');const action=target.dataset.action;try{target.disabled=true;if(action==='copy-plan-hash'){const hashStatus=document.getElementById('plan-hash-status');hashStatus.textContent='Copying plan hash...';try{await copyText(target.dataset.hash);hashStatus.textContent='Plan hash copied.'}catch{hashStatus.textContent='Copy failed. Select the plan hash text and copy it manually.'}finally{target.disabled=false}}else if(action==='create-session'){currentSession=await api('/api/sessions',{...currentInput,confirmLocalSession:true});const binding=currentSession.repositoryBinding;const repositoryScope=binding?'<div class="footnote"><strong>Repository authority</strong><br>Push source: <code>'+esc(binding.sourceRepository)+'</code><br>Issue and Draft PR target: <code>'+esc(binding.issueRepository)+'</code><br>Mode: <code>'+esc(binding.mode)+'</code><br>Starting commit: <span class="hash">'+esc(binding.startingCommit)+'</span></div>':'';panel.innerHTML='<h3>Review the exact execution authority</h3><p class="hash">Plan '+esc(currentSession.plan.planHash)+'</p>'+repositoryScope+'<p>This approval may generate a patch, create an isolated local commit, run the registered test, push one <code>foursday/</code> branch, and open one Draft PR. It cannot merge or deploy.</p><div class="approval-fields"><label class="field"><span>Approval reason</span><input id="approval-reason" value="I reviewed the repository, Issue, five steps, evidence, and rollback boundaries."></label><label class="field"><span>My active minutes</span><input id="human-minutes" type="number" min="0" max="120" value="15"></label></div><label class="approval-check"><input id="approval-check" type="checkbox"> <span>I approve this exact plan hash once. I understand that Git push and Draft PR creation are external side effects.</span></label><div class="execution-actions"><button class="action" type="button" data-action="approve-session">Approve exact hash and run</button></div><p id="execution-status" class="hint"></p>'}else if(action==='approve-session'){if(!document.getElementById('approval-check').checked)throw new Error('Check the exact-plan approval box first');const status=document.getElementById('execution-status');status.textContent='Running the approved steps. You can request cancellation while an interruptible step is active.';target.parentElement.insertAdjacentHTML('beforeend','<button class="secondary danger" type="button" data-action="cancel-session">Request safe cancellation</button>');const completed=await api('/api/sessions/'+encodeURIComponent(currentSession.sessionId)+'/approve',{approved:true,planHash:currentSession.plan.planHash,reason:document.getElementById('approval-reason').value,humanActiveMinutes:Number(document.getElementById('human-minutes').value)},900000);currentSession={...currentSession,...completed};const rows=completed.evidence.map(item=>'<div class="evidence-row"><strong>'+esc(human(item.capability))+'</strong><span>'+esc(item.kind||item.error||item.status)+' · '+esc(item.verification||item.status)+'</span></div>').join('');panel.innerHTML='<h3>'+(completed.status==='completed'?'Verified delivery completed':'Delivery stopped: '+esc(completed.status))+'</h3>'+rows+(completed.status==='completed'?'<p>Draft PR, project-memory candidate, and time-return proposal were created from read-back evidence. Neither memory nor returned time counts until you confirm them.</p><div class="execution-actions"><button class="secondary" type="button" data-action="confirm-outcomes">Confirm memory and returned time</button><button class="secondary" type="button" data-action="download-evidence">Download evidence bundle</button></div><p id="evidence-download-status" class="hint" role="status" aria-live="polite" aria-atomic="true"></p>':'')}else if(action==='cancel-session'){await api('/api/sessions/'+encodeURIComponent(currentSession.sessionId)+'/cancel',{planHash:currentSession.plan.planHash});target.textContent='Cancellation requested';target.disabled=true}else if(action==='confirm-outcomes'){const confirmed=await api('/api/sessions/'+encodeURIComponent(currentSession.sessionId)+'/outcomes',{memoryId:currentSession.memoryCandidate?.id,timeReturnId:currentSession.timeReturn?.id});const journey=confirmed.localJourney?'<br>Measured server-start-to-confirmed journey: '+esc(confirmed.localJourney.serverStartToConfirmedSeconds)+' seconds ('+(confirmed.localJourney.serverJourneyWithinTenMinutes?'within':'over')+' 10 minutes). Package download time is not included.':'';panel.innerHTML+='<div class="footnote"><strong>Outcome confirmed.</strong> Project memory is '+esc(confirmed.memory?.status||'unchanged')+'; '+esc(confirmed.timeReturn?.returnedMinutes??0)+' evidence-backed minutes were returned.'+journey+' Download the evidence bundle again to capture the confirmed closed loop.</div><div class="execution-actions"><button class="secondary" type="button" data-action="copy-public-proof">Copy privacy-safe pilot proof</button><a class="secondary" href="https://github.com/ruiwang20010702/foursday/issues/49#new_comment_field" target="_blank" rel="noopener noreferrer">Open pilot Issue #49</a></div><p id="public-proof-status" class="hint" role="status" aria-live="polite" aria-atomic="true"></p>';target.remove()}else if(action==='download-evidence'){const downloadStatus=document.getElementById('evidence-download-status');downloadStatus.textContent='Downloading evidence bundle...';try{await downloadEvidence();downloadStatus.textContent='Evidence bundle downloaded.'}catch{downloadStatus.textContent='Evidence bundle download failed. Try again.'}finally{target.disabled=false}}else if(action==='copy-public-proof'){const proofStatus=document.getElementById('public-proof-status');proofStatus.textContent='Copying privacy-safe pilot proof...';try{await copyPublicProof();proofStatus.textContent='Pilot proof copied. Replace tester-XX and add your install timing and feedback before posting.'}catch{proofStatus.textContent='Pilot proof copy failed. Download the private evidence bundle and try again.'}finally{target.disabled=false}}}catch(error){const status=document.getElementById('execution-status');if(status)status.textContent=error.message;else if(panel)panel.insertAdjacentHTML('beforeend','<p class="error">'+esc(error.message)+'</p>');target.disabled=false}});
</script>
</body>
</html>`;

const chineseActivationCopy = Object.freeze([
  ["<title>Start with Foursday</title>", "<title>开始使用 Foursday</title>"],
  ["Turn one GitHub Issue into a governed, reviewable Draft PR with explicit approval and read-back evidence.", "通过明确审批和目标回读证据，把一个 GitHub Issue 转化为受治理、可审查的 Draft PR。"],
  ["Turn a GitHub issue into a project-bound, reviewable delivery plan. Foursday shows every capability, risk level, and expected proof before anything can run.", "把 GitHub Issue 转化为绑定项目、可审查的交付计划。任何动作开始前，Foursday 都会展示能力、风险等级和预期证据。"],
  ["The reviewed command fixed a candidate commit. First run the read-only readiness check: it reports only whether GitHub CLI authentication and supported agent runtimes are available. After your separate confirmation, Foursday can create or reuse your personal GitHub fork, clone it into ", "经过审阅的命令已经固定候选提交。请先运行只读就绪检查：它只报告 GitHub CLI 登录状态和可用的智能体运行时。经过你的单独确认后，Foursday 可以创建或复用你的个人 GitHub Fork，并克隆到 "],
  [", bind the credential-free upstream, check out that exact commit, and install lockfile dependencies without lifecycle scripts. It will not run a model, create a delivery branch, push, open a PR, merge, or deploy.", "，绑定不含凭据的上游仓库，签出精确提交，并在禁用生命周期脚本的情况下安装锁定依赖。它不会运行模型、创建交付分支、推送、创建 PR、合并或部署。"],
  ["Foursday will build the same immutable five-step recipe used by the governed runtime. External effects remain disabled; local preparation remains approval-bound. Downloaded evidence retains Issue and PR URLs, plan and commit evidence, and confirmed outcomes while omitting local paths, remotes, tokens, credentials, and model output.", "Foursday 将生成与受治理运行时相同的不可变五步配方。外部副作用仍然关闭，本地准备仍需审批。下载的证据保留 Issue 与 PR 地址、计划与提交证据和已确认结果，同时排除本地路径、远端地址、令牌、凭据和模型输出。"],
  ["I authorize creation or reuse of my personal Foursday fork, a local clone in the fixed pilot directory, and a locked dependency install.", "我授权创建或复用我的个人 Foursday Fork，在固定体验目录中建立本地克隆，并安装锁定依赖。"],
  ["Use a public GitHub issue URL or one you are already authorized to access. The preview does not call GitHub.", "使用公开的 GitHub Issue 地址，或你已经有权访问的 Issue。预览不会调用 GitHub。"],
  ["The root must be a real Git repository. This preview does not save a project manifest.", "项目根目录必须是真实的 Git 仓库。此预览不会保存项目清单。"],
  ["Give your coding agent one real job.", "把一项真实工作交给你的编码智能体。"],
  ["Prepare the official v0.5 pilot in this page", "在本页准备官方 v0.5 体验"],
  ["Check the exact-plan approval box first", "请先勾选精确计划审批确认框"],
  ["I approve this exact plan hash once. I understand that Git push and Draft PR creation are external side effects.", "我单次批准这个精确计划哈希，并理解 Git 推送和创建 Draft PR 属于外部副作用。"],
  ["I reviewed the repository, Issue, five steps, evidence, and rollback boundaries.", "我已审阅仓库、Issue、五个步骤、证据和回退边界。"],
  ["The next action writes an encrypted local SQLite session and rechecks the clean Git repository, fixed npm test script, origin remote, agent executable, and GitHub CLI. It still does not call the model or GitHub. Execution requires a second, exact-hash approval.", "下一步会写入加密的本地 SQLite 会话，并重新核对干净的 Git 仓库、固定 npm 测试脚本、origin 远端、智能体可执行文件和 GitHub CLI。此时仍不会调用模型或 GitHub；执行还需要第二次精确哈希审批。"],
  ["This approval may generate a patch, create an isolated local commit, run the registered test, push one ", "此审批可以生成补丁、创建隔离的本地提交、运行登记测试、推送一个 "],
  [" branch, and open one Draft PR. It cannot merge or deploy.", " 分支并创建一个 Draft PR，但不能合并或部署。"],
  ["Running the approved steps. You can request cancellation while an interruptible step is active.", "正在运行已批准步骤。可中断步骤执行期间，你可以请求安全取消。"],
  ["Draft PR, project-memory candidate, and time-return proposal were created from read-back evidence. Neither memory nor returned time counts until you confirm them.", "已根据回读证据创建 Draft PR、项目记忆候选和时间返还提案。记忆与返还时间都必须由你确认后才会生效。"],
  ["Project memory is ", "项目记忆状态为 "],
  [" evidence-backed minutes were returned.", " 分钟证据支持的时间已返还。"],
  ["Measured server-start-to-confirmed journey: ", "服务启动到确认的实测用时："],
  [" seconds (", " 秒（"],
  [") 10 minutes). Package download time is not included.", " 10 分钟）。不包含包下载时间。"],
  ["Ready for fork preparation and governed execution.", "已可准备 Fork 并执行受治理流程。"],
  ["Fork preparation is ready. Install or configure at least one supported agent runtime before execution.", "Fork 准备已就绪。执行前请安装或配置至少一种受支持的智能体运行时。"],
  ["Install and authenticate GitHub CLI before preparing the pilot fork.", "准备体验 Fork 前，请先安装并登录 GitHub CLI。"],
  ["Readiness check failed safely. No fork, branch, push, or PR was created.", "就绪检查已安全失败；未创建 Fork、分支、推送或 PR。"],
  ["Checking GitHub authentication and local agent runtimes...", "正在检查 GitHub 登录和本地智能体运行时……"],
  ["OpenAI-compatible configuration is incomplete or invalid; configure BASE_URL, API_KEY, and MODEL together before restart.", "OpenAI 兼容配置不完整或无效；重启前请同时配置 BASE_URL、API_KEY 和 MODEL。"],
  ["Blocked? Share only a bounded readiness report", "遇到阻塞？只分享受限的就绪报告"],
  ["Copy the fixed candidate and readiness booleans without paths, usernames, private repository details, logs, model output, or credentials. Review it before posting.", "复制固定候选与就绪布尔值，不包含路径、用户名、私有仓库详情、日志、模型输出或凭据。发布前请人工审阅。"],
  ["Readiness report copied. Review it, add only a redacted symptom, then post voluntarily.", "就绪报告已复制。请审阅，仅补充脱敏现象，再自愿发布。"],
  ["Readiness report copy failed. Open the bug form and enter only redacted details.", "复制就绪报告失败。请打开缺陷表单，并且只填写脱敏信息。"],
  ["Setup check-in copied. Choose your platform, add time and one friction point, then post voluntarily.", "安装签到已复制。请选择平台、补充用时和一个卡点，再自愿发布。"],
  ["Setup check-in copy failed. Open Issue #50 and use its bounded template.", "复制安装签到失败。请打开 Issue #50 并使用其中的受限模板。"],
  ["Preparing a bounded task draft locally...", "正在本地准备受限任务草稿……"],
  ["Task draft ready. Review and submit it on GitHub, then paste the new Issue URL below. No Issue has been created yet.", "任务草稿已就绪。请在 GitHub 审阅并提交，然后把新 Issue 地址粘贴到下方。当前尚未创建任何 Issue。"],
  ["Use tester- followed by 3-24 lowercase letters, numbers, or hyphens.", "请使用 tester- 加 3–24 个小写字母、数字或连字符。"],
  ["Confirm the fork, clone, and locked dependency install first.", "请先确认 Fork、克隆和锁定依赖安装。"],
  ["Preparing the authorized fork and local checkout...", "正在准备已授权的 Fork 和本地签出……"],
  ["Pilot workspace ready. Review the repository root and continue to build the plan.", "体验工作区已就绪。请审阅仓库根目录，然后继续生成计划。"],
  ["Pilot preparation failed. Check GitHub CLI login and retry; no delivery branch or PR was created.", "体验准备失败。请检查 GitHub CLI 登录后重试；未创建交付分支或 PR。"],
  ["Ready to use a real agent?", "准备使用真实智能体了吗？"],
  ["Choose Codex, Claude Code, or a configured compatible provider to create an approval-bound execution session.", "选择 Codex、Claude Code 或已配置的兼容提供方，创建受审批约束的执行会话。"],
  ["Execution is unavailable in this package mode", "此包模式无法执行"],
  ["The five-step plan remains reviewable, but this server exposes no execution coordinator.", "五步计划仍可审阅，但此服务未开放执行协调器。"],
  ["Continue to a real Draft PR", "继续创建真实 Draft PR"],
  ["Creating local execution session", "正在创建本地执行会话"],
  ["Create local execution session", "创建本地执行会话"],
  ["Building the plan…", "正在生成计划……"],
  ["Safe preview complete", "安全预览已完成"],
  ["Copy plan hash", "复制计划哈希"],
  ["Copying plan hash...", "正在复制计划哈希……"],
  ["Plan hash copied.", "计划哈希已复制。"],
  ["Copy failed. Select the plan hash text and copy it manually.", "复制失败。请选择计划哈希文本并手动复制。"],
  ["0 external systems touched", "未触碰任何外部系统"],
  ["Why execution is blocked:", "执行被阻止的原因："],
  ["Configure explicit authority for ", "请先为以下能力配置明确授权："],
  ["one or more required capabilities", "一项或多项必需能力"],
  ["This is an honest activation preview—not a claim that code, a branch, or a pull request already exists.", "这是如实的接入预览，不代表代码、分支或 Pull Request 已经存在。"],
  ["Review the exact execution authority", "审阅精确执行权限"],
  ["Repository authority", "仓库权限范围"],
  ["Push source:", "推送来源："],
  ["Issue and Draft PR target:", "Issue 与 Draft PR 目标："],
  ["Starting commit:", "起始提交："],
  ["Approval reason", "审批理由"],
  ["My active minutes", "我的主动投入分钟数"],
  ["Approve exact hash and run", "批准精确哈希并运行"],
  ["Request safe cancellation", "请求安全取消"],
  ["Cancellation requested", "已请求取消"],
  ["Verified delivery completed", "已完成并验证交付"],
  ["Delivery stopped: ", "交付已停止："],
  ["Confirm memory and returned time", "确认记忆和返还时间"],
  ["Download evidence bundle", "下载证据包"],
  ["Downloading evidence bundle...", "正在下载证据包……"],
  ["Evidence bundle downloaded.", "证据包已下载。"],
  ["Evidence bundle download failed. Try again.", "下载证据包失败，请重试。"],
  ["No completed activation session is available", "当前没有可下载的已完成接入会话"],
  ["No confirmed activation session is available", "当前没有可导出的已确认接入会话"],
  ["Evidence download failed", "证据下载失败"],
  ["Public proof export failed", "公开证明导出失败"],
  ["Clipboard is unavailable", "剪贴板不可用"],
  ["Outcome confirmed.", "结果已确认。"],
  ["Download the evidence bundle again to capture the confirmed closed loop.", "请再次下载证据包，以记录已确认的完整闭环。"],
  ["Copy privacy-safe pilot proof", "复制隐私安全体验证明"],
  ["Open pilot Issue #49", "打开体验 Issue #49"],
  ["Copying privacy-safe pilot proof...", "正在复制隐私安全体验证明……"],
  ["Pilot proof copied. Replace tester-XX and add your install timing and feedback before posting.", "体验证明已复制。发布前请替换 tester-XX，并补充安装用时和反馈。"],
  ["Pilot proof copy failed. Download the private evidence bundle and try again.", "复制体验证明失败。请下载私有证据包后重试。"],
  ["YOUR FIRST SAFE HANDOFF", "第一次安全交接"],
  ["Your first safe handoff", "第一次安全交接"],
  ["Accounts required", "所需账号"],
  ["None for preview", "预览无需账号"],
  ["Preview storage", "预览存储"],
  ["<strong>None</strong>", "<strong>无</strong>"],
  ["<span>Execution</span>", "<span>执行</span>"],
  ["Local SQLite · exact approval", "本地 SQLite · 精确审批"],
  ["10-MINUTE SETUP", "10 分钟接入"],
  ["10-minute setup", "10 分钟接入"],
  ["GitHub delivery preview", "GitHub 交付预览"],
  ["Local · no writes", "本机 · 零写入"],
  ["Bind a project", "绑定项目"],
  ["Candidate ", "候选提交 "],
  ["Check pilot readiness", "检查体验就绪状态"],
  ["Prepare my pilot fork", "准备我的体验 Fork"],
  ["Project ID", "项目编号"],
  ["Project name", "项目名称"],
  ["value=\"My project\"", "value=\"我的项目\""],
  ["Git repository root", "Git 仓库根目录"],
  ["Local owner ID", "本地负责人编号"],
  ["Agent runtime", "智能体运行时"],
  ["Deterministic preview", "确定性预览"],
  ["OpenAI-compatible", "OpenAI 兼容"],
  ["Choose the work", "选择工作"],
  ["GitHub issue URL", "GitHub Issue 地址"],
  ["Confirmed change request", "已确认的变更请求"],
  ["Describe the smallest acceptable change and its boundary.", "描述最小可接受变更及其边界。"],
  ["Base branch", "基础分支"],
  ["Registered test command ID", "已登记测试命令编号"],
  ["Draft PR title", "Draft PR 标题"],
  ["fix: describe the verified change", "fix: 描述已验证的变更"],
  ["Review before authority", "授权前审阅"],
  ["Build my reviewable plan", "生成可审查计划"],
  ["GitHub authenticated", "GitHub 已登录"],
  ["GitHub CLI", "GitHub CLI"],
  ["Not ready", "未就绪"],
  ["Ready", "已就绪"],
  ["Copy privacy-safe readiness report", "复制隐私安全就绪报告"],
  ["Open bug report", "打开缺陷报告"],
  ["Copy setup check-in", "复制安装签到"],
  ["Open setup Issue #50", "打开安装 Issue #50"],
  ["Create your unique pilot task", "创建你的唯一体验任务"],
  ["Issue #49 is only for intake and feedback. A random pseudonymous alias is created in this browser so you can start immediately without waiting for a maintainer. You may replace it with another ", "Issue #49 只用于接入和反馈。浏览器会随机生成一个化名，让你无需等待维护者即可开始；你也可以替换为另一个 "],
  [" alias before creating the task.", " 化名后再创建任务。"],
  ["Self-chosen pilot alias", "自选体验化名"],
  ["Prepare unique task link", "准备唯一任务链接"],
  ["Open my unique task Issue", "打开我的唯一任务 Issue"],
  ["Setup changed after pilot preparation", "体验准备后安装状态已变化"],
  ["Copying bounded readiness report...", "正在复制受限就绪报告……"],
  ["Copying privacy-safe setup check-in...", "正在复制隐私安全安装签到……"],
  ["<div class=\"hash\" id=\"plan-hash\">Plan ", "<div class=\"hash\" id=\"plan-hash\">计划 "],
  ["<p class=\"hash\">Plan ", "<p class=\"hash\">计划 "],
  ["Mode:", "模式："],
  ["serverJourneyWithinTenMinutes?'within':'over'", "serverJourneyWithinTenMinutes?'未超过':'超过'"],
  [" 10 minutes). Package download time is not included.", " 10 分钟）。不包含包下载时间。"],
  ["Request failed", "请求失败"],
  ["Language", "语言"],
]);

export function activationHtmlForLanguage(language = "en") {
  if (!String(language).toLowerCase().startsWith("zh")) return activationHtml;
  let localized = activationHtml
    .replace('<html lang="en">', '<html lang="zh-CN">')
    .replace(
      '<a class="active" aria-current="page" href="?lang=en">EN</a><a href="?lang=zh">中文</a>',
      '<a href="?lang=en">EN</a><a class="active" aria-current="page" href="?lang=zh">中文</a>',
    );
  for (const [english, chinese] of [...chineseActivationCopy]
    .sort(([left], [right]) => right.length - left.length)) {
    localized = localized.replaceAll(english, chinese);
  }
  return localized;
}

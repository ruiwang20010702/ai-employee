export const personalDashboardHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Foursday 个人工作台</title>
  <style nonce="__NONCE__">
    :root{--bg:#f4f2ec;--paper:#fffdf8;--ink:#17201c;--muted:#65706b;--line:#ddd9cf;--green:#155f49;--soft:#e5f0ea;--amber:#8b5b13;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}button,input,textarea{font:inherit}.shell{max-width:1180px;margin:auto;padding:32px 24px 80px}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:24px}.top h1{margin:0 0 6px;font-size:32px}.sub,.hint{color:var(--muted)}.toolbar{display:flex;gap:8px;flex-wrap:wrap}.btn{border:1px solid var(--line);border-radius:9px;background:var(--paper);padding:9px 14px;color:var(--ink);cursor:pointer;text-decoration:none}.btn.primary{background:var(--green);border-color:var(--green);color:white}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.metric,.card{background:var(--paper);border:1px solid var(--line);border-radius:14px}.metric{padding:18px}.metric strong{display:block;font-size:28px;margin-top:8px}.card{padding:20px;margin:14px 0}.card h2,.card h3{margin-top:0}.row{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.pill{display:inline-block;background:var(--soft);color:var(--green);border-radius:999px;padding:4px 9px;font-size:12px}.recipes{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.recipe{border:1px solid var(--line);border-radius:10px;padding:14px}.form{display:grid;grid-template-columns:1fr 1fr;gap:12px}.field{display:block}.field span{display:block;color:var(--muted);font-size:13px;margin-bottom:6px}.field input,.field textarea{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:#fff}.wide{grid-column:1/-1}.hidden{display:none}.empty{padding:36px;text-align:center;color:var(--muted)}dialog{border:0;padding:0;background:transparent;width:min(760px,calc(100vw - 32px))}dialog::backdrop{background:#17201c99}@media(max-width:760px){.grid,.recipes,.form{grid-template-columns:1fr}.top{display:block}.toolbar{margin-top:14px}.wide{grid-column:auto}}
  </style>
</head>
<body>
<main class="shell">
  <header class="top">
    <div><h1>你的 Foursday</h1><div class="sub">目标、配方、项目记忆和真正返还的时间</div></div>
    <div class="toolbar"><a class="btn" href="/">运维管理</a><button id="refresh" class="btn">刷新</button><button id="setup" class="btn primary">接入项目</button></div>
  </header>
  <section id="login" class="card">
    <h2>进入个人工作台</h2>
    <p class="hint">令牌只保存在当前标签页。创建项目、启动配方和确认时间返还需要写入令牌。</p>
    <div class="form"><label class="field"><span>只读令牌</span><input id="read" type="password"></label><label class="field"><span>写入令牌</span><input id="write" type="password"></label></div>
    <p><button id="enter" class="btn primary">进入</button></p>
  </section>
  <section id="app" class="hidden"><div id="summary" class="grid"></div><div id="projects"></div></section>
</main>
<dialog id="wizard">
  <form method="dialog" class="card">
    <h2>项目接入向导</h2>
    <div class="form">
      <label class="field"><span>项目编号</span><input id="project-id" required placeholder="my_project"></label>
      <label class="field"><span>项目名称</span><input id="project-name" required></label>
      <label class="field wide"><span>本机项目根目录</span><input id="project-root" required placeholder="/absolute/path"></label>
      <label class="field"><span>请求人账号</span><input id="requester" required></label>
      <label class="field"><span>记忆保留天数</span><input id="retention" type="number" min="1" max="365" value="90"></label>
      <label class="field wide"><span>项目目标</span><textarea id="objective" required></textarea></label>
      <label class="field wide"><span>成功标准（每行一条）</span><textarea id="criteria"></textarea></label>
      <label class="field wide"><span>选择配方（逗号分隔编号）</span><input id="recipe-ids" placeholder="project-follow-up, daily-report"></label>
    </div>
    <p class="hint">默认只自动开放研究与文档草稿；代码改动和本地分支仍需审批；推送、发布和办公写入保持关闭。</p>
    <div class="toolbar"><button value="cancel" class="btn">取消</button><button id="create-project" value="default" class="btn primary">创建安全项目</button></div>
  </form>
</dialog>
<script nonce="__NONCE__">
const byId=id=>document.getElementById(id);
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
let state={projects:[],recipes:[],timeReturns:[],triggers:[],weeklyDelegation:null};
async function api(path,{method='GET',body,write=false}={}){
  const headers={Authorization:'Bearer '+sessionStorage.getItem('foursday-read')};
  if(body)headers['Content-Type']='application/json';
  if(write)headers['X-Foursday-Write-Token']=sessionStorage.getItem('foursday-write');
  const response=await fetch(path,{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||'请求失败');
  return result;
}
function recipeCards(project){
  const recipes=project.recipes||[];
  if(!recipes.length)return '<p class="hint">尚未选择配方，可通过受控项目清单更新后再使用。</p>';
  return '<div class="recipes">'+recipes.map(recipe=>'<div class="recipe"><strong>'+escapeHtml(recipe.name)+'</strong><p class="hint">'+escapeHtml(recipe.description)+'</p><button class="btn" data-recipe="'+escapeHtml(recipe.id)+'" data-project="'+escapeHtml(project.projectId)+'">生成一次计划</button> <button class="btn" data-trigger-recipe="'+escapeHtml(recipe.id)+'" data-project="'+escapeHtml(project.projectId)+'">设为定时工作</button></div>').join('')+'</div>';
}
function triggerRows(project){
  const items=state.triggers.filter(item=>item.projectId===project.projectId);
  if(!items.length)return '<p class="hint">尚未设置主动工作。新触发器始终先以停用状态保存。</p>';
  return items.map(item=>'<p><strong>'+escapeHtml(item.id)+'</strong> · '+escapeHtml(item.recipeId)+' · '+escapeHtml(item.kind)+(item.nextRunAt?' · 下次 '+escapeHtml(item.nextRunAt):'')+' <span class="pill">'+escapeHtml(item.status)+'</span> <button class="btn" data-trigger="'+escapeHtml(item.id)+'" data-enable="'+String(item.status!=='enabled')+'">'+(item.status==='enabled'?'停用':'启用')+'</button></p>').join('');
}
function timeReturnCandidates(project){
  const candidates=project.timeReturnCandidates||[];
  if(!candidates.length)return '';
  return '<h3>可核销的已完成工作</h3>'+candidates.map(item=>'<p>'+escapeHtml(item.objective)+' · 基线 '+item.baselineMinutes+' 分钟 <button class="btn" data-propose-time="'+escapeHtml(item.workPlanId)+'" data-baseline="'+item.baselineMinutes+'">填写本人投入</button></p>').join('');
}
function memorySyncBlock(project){
  const sync=project.memorySync||{};
  if(!sync.authorized)return '<div class="wide"><h3>项目记忆自动同步</h3><p class="hint">尚未授权。需要先在项目清单固定来源文件、事实前缀和保留期；工作台不会替你扩大权限。</p></div>';
  const labels={not_started:'尚未运行',synchronized:'已同步',unchanged:'来源未变化',review_required:'需要审阅',failed:'同步失败',unknown:'状态未知'};
  const sources=(sync.sourcePaths||[]).map(path=>'<code>'+escapeHtml(path)+'</code>').join('、')||'未配置';
  const policy=sync.mode==='automatic'?(sync.autoConfirm?'低风险事实可自动确认':'只自动形成候选'):'每次应用需摘要确认';
  const timing=sync.lastCheckedAt?'最近检查 '+escapeHtml(sync.lastCheckedAt):'尚无同步记录';
  const evidence=sync.sourceDigestPrefix?' · 来源摘要 '+escapeHtml(sync.sourceDigestPrefix)+'…':'';
  const error=sync.errorCode?' · 错误 '+escapeHtml(sync.errorCode):'';
  return '<div class="wide"><h3>项目记忆自动同步 <span class="pill">'+escapeHtml(labels[sync.state]||sync.state)+'</span></h3><p>授权来源：'+sources+'</p><p class="hint">策略：'+escapeHtml(policy)+' · 待审 '+escapeHtml(sync.reviewRequired||0)+' · 本轮确认 '+escapeHtml(sync.memoriesConfirmed||0)+'</p><p class="hint">'+timing+evidence+error+'</p><p class="hint">冲突和敏感内容只进入例外审查；此处只读，不会启动同步、发送消息或执行计划。</p></div>';
}
function projectDetails(project){
  const work=(project.plans.items||[]).slice(0,5).map(item=>'<li><span class="pill">'+escapeHtml(item.status)+'</span> '+escapeHtml(item.objective)+' · '+item.steps.completed+'/'+item.steps.total+' 步</li>').join('');
  const memory=(project.memory.items||[]).slice(0,5).map(item=>'<li>'+escapeHtml(item.factKey||'project.fact')+'：'+escapeHtml(item.statement)+'</li>').join('');
  const deliverables=(project.deliverables||[]).slice(0,5).map(item=>'<li>'+escapeHtml(item.capability)+' · '+escapeHtml(item.kind||'evidence')+(item.reference?' · '+escapeHtml(item.reference):'')+'</li>').join('');
  const graph=project.governedGraph||{};
  const graphRows=(graph.explanations||[]).slice(0,5).map(item=>'<li>'+escapeHtml(item.planId)+' · 执行对齐：<span class="pill">'+escapeHtml(item.drift.status)+'</span> · 项目变化：'+escapeHtml(item.changes.status)+'</li>').join('');
  const graphBlock=graph.available?'<div class="wide"><h3>受治理工作图</h3><p class="hint">'+graph.nodeCount+' 个节点 · '+graph.edgeCount+' 条关系 · 对齐 '+graph.alignedPlans+' · 偏离 '+graph.driftedPlans+' · 证据不完整 '+graph.incompletePlans+'</p>'+(graphRows?'<ul>'+graphRows+'</ul>':'<p class="hint">尚无可解释的计划投影。</p>')+'<p class="hint">这里仅解释已有证据；授权、预算和审批仍以领域账本为准。</p></div>':'';
  return '<div class="form"><div><h3>近期工作</h3>'+(work?'<ul>'+work+'</ul>':'<p class="hint">暂无工作计划</p>')+'</div><div><h3>项目记忆</h3>'+(memory?'<ul>'+memory+'</ul>':'<p class="hint">暂无经确认记忆</p>')+'<p class="hint">待审候选 '+escapeHtml(project.memory.proposed||0)+' · 冲突 '+escapeHtml(project.memory.conflictsPendingReview||0)+'</p></div>'+memorySyncBlock(project)+'<div class="wide"><h3>交付物证据</h3>'+(deliverables?'<ul>'+deliverables+'</ul>':'<p class="hint">暂无已验收交付物</p>')+'</div>'+graphBlock+'</div>';
}
function projectCard(project){
  const coverage=project.timeReturn.weeklyAutomationCoverage==null?'—':Math.round(project.timeReturn.weeklyAutomationCoverage*1000)/10+'%';
  return '<article class="card"><div class="row"><div><h2>'+escapeHtml(project.name)+'</h2><p>'+escapeHtml(project.objective||'尚未设置目标')+'</p></div><span class="pill">'+project.plans.active+' 个进行中</span></div><div class="grid"><div class="metric">里程碑<strong>'+project.milestones.length+'</strong></div><div class="metric">正式记忆<strong>'+project.memory.confirmed+'</strong></div><div class="metric">决策 / 风险<strong>'+project.memory.decisions+' / '+project.memory.risks+'</strong></div><div class="metric">本周返还<strong>'+project.timeReturn.weeklyReturnedHours+'h</strong></div><div class="metric">本周已验证自动化率<strong>'+coverage+'</strong></div></div>'+projectDetails(project)+'<h3>可用配方</h3>'+recipeCards(project)+'<h3>主动工作</h3>'+triggerRows(project)+timeReturnCandidates(project)+'<p class="hint">本周从周一开始；自动化率只统计本周有完整证据并经本人确认的配方基线，不代表全部工作。</p><p class="hint">成功标准：'+escapeHtml(project.successCriteria.join('；')||'尚未设置')+'</p></article>';
}
function weeklyDelegationCard(){
  const weekly=state.weeklyDelegation;if(!weekly)return '';
  const hours=Math.round(weekly.remainingMinutes/6)/10;
  const projected=Math.round(weekly.projectedVerifiedReturnedMinutes/6)/10;
  if(weekly.targetMet)return '<article class="card"><h2>本周工作返还队列</h2><p><span class="pill">本周目标已完成</span> 已返还 '+Math.round(weekly.weeklyReturnedMinutes/6)/10+' 小时。</p><p class="hint">队列不会为了增加数字而重复推荐工作。</p></article>';
  const rows=(weekly.items||[]).slice(0,8).map(item=>{
    const evidence=item.evidenceStatus==='verified_history'?'保守预计返还 '+Math.round(item.conservativeReturnedMinutes/6)/10+'h · '+item.evidenceSamples+' 条本人确认记录':'尚无本人确认的返还记录 · 本次只用于验证基线';
    const gate=weekly.executionEnabled?(item.approvalRequired?' · 需要审批':' · 可按项目策略进入计划'):' · 计划执行仍关闭';
    return '<div class="recipe"><strong>'+escapeHtml(item.projectName)+' · '+escapeHtml(item.recipeName)+'</strong><p class="hint">'+escapeHtml(evidence+gate)+'</p><button class="btn" data-recipe="'+escapeHtml(item.recipeId)+'" data-project="'+escapeHtml(item.projectId)+'">生成受控计划</button></div>';
  }).join('');
  const pending=weekly.remainingAfterVerifiedQueueMinutes>0?'按已有证据排完后仍差 '+Math.round(weekly.remainingAfterVerifiedQueueMinutes/6)/10+'h；需要验证更多配方或继续由本人完成。':'已有证据队列覆盖本周剩余目标，但只有完成、回读并由本人确认后才计入。';
  const exclusions='进行中 '+(weekly.inProgress||[]).length+' 项 · 权限阻断 '+(weekly.blocked||[]).length+' 项';
  return '<article class="card"><div class="row"><div><h2>本周工作返还队列</h2><p>距离 8 小时目标还差 '+hours+'h；已验证候选保守覆盖 '+projected+'h。</p></div><span class="pill">只规划，不执行</span></div>'+(rows?'<div class="recipes">'+rows+'</div>':'<p class="hint">暂无可推荐配方。先接入项目、选择配方，或等待正在进行的计划完成。</p>')+'<p class="hint">'+escapeHtml(pending)+' 未验证配方不计入预计返还；禁用能力和活动中的同配方不会重复推荐。</p><p class="hint">'+escapeHtml(exclusions)+'</p></article>';
}
function render(){
  const proposed=state.timeReturns.filter(item=>item.status==='proposed');
  const returnedMinutes=state.projects.reduce((sum,item)=>sum+item.timeReturn.weeklyReturnedMinutes,0);
  const baselineMinutes=state.projects.reduce((sum,item)=>sum+item.timeReturn.weeklyBaselineMinutes,0);
  const coverage=baselineMinutes===0?'—':Math.round(returnedMinutes/baselineMinutes*1000)/10+'%';
  const targetProgress=Math.min(100,Math.round(returnedMinutes/480*1000)/10)+'%';
  byId('summary').innerHTML=[['项目',state.projects.length],['已完成计划',state.projects.reduce((sum,item)=>sum+item.plans.completed,0)],['待确认返还',proposed.length],['本周返还小时',Math.round(returnedMinutes/6)/10],['周目标进度',targetProgress],['本周已验证自动化率',coverage]].map(item=>'<div class="metric">'+item[0]+'<strong>'+item[1]+'</strong></div>').join('');
  byId('projects').innerHTML=weeklyDelegationCard()+(state.projects.map(projectCard).join('')||'<div class="empty">还没有项目。点击“接入项目”，10 分钟内完成目标、记忆范围、配方和安全默认能力配置。</div>');
  if(proposed.length)byId('projects').insertAdjacentHTML('afterbegin','<article class="card"><h2>待确认的时间返还</h2>'+proposed.map(item=>'<p><strong>'+item.returnedMinutes+' 分钟</strong> · '+escapeHtml(item.recipeId)+' <button class="btn" data-time="'+escapeHtml(item.id)+'" data-decision="confirmed">确认</button> <button class="btn" data-time="'+escapeHtml(item.id)+'" data-decision="rejected">不计入</button></p>').join('')+'<p class="hint">只有完整回读证据与本人确认都成立，才计入总数。</p></article>');
}
async function load(){
  const result=await Promise.all([api('/api/projects'),api('/api/recipes'),api('/api/time-returns'),api('/api/triggers')]);
  state={projects:result[0].items,weeklyDelegation:result[0].weeklyDelegation,recipes:result[1].items,timeReturns:result[2].items,triggers:result[3].items};
  render();
}
byId('enter').onclick=async()=>{
  sessionStorage.setItem('foursday-read',byId('read').value);
  sessionStorage.setItem('foursday-write',byId('write').value);
  await load();byId('login').classList.add('hidden');byId('app').classList.remove('hidden');
};
byId('refresh').onclick=()=>load().catch(error=>alert(error.message));
byId('setup').onclick=()=>{byId('recipe-ids').placeholder=state.recipes.map(item=>item.id).join(', ');byId('wizard').showModal()};
byId('create-project').onclick=async event=>{
  event.preventDefault();
  const lines=id=>byId(id).value.split('\\n').map(value=>value.trim()).filter(Boolean);
  await api('/api/projects/onboarding',{method:'POST',write:true,body:{projectId:byId('project-id').value,name:byId('project-name').value,rootDirectory:byId('project-root').value,requesterIds:[byId('requester').value],profile:{objective:byId('objective').value,successCriteria:lines('criteria'),selectedRecipeIds:byId('recipe-ids').value.split(',').map(value=>value.trim()).filter(Boolean),memoryScope:{allowedTypes:['project','principle'],retentionDays:Number(byId('retention').value)}}}});
  byId('wizard').close();await load();
};
byId('projects').onclick=async event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.proposeTime){
    const raw=prompt('这项工作如果由你亲自完成，实际投入了多少分钟？基线为 '+button.dataset.baseline+' 分钟。');if(raw==null)return;
    await api('/api/time-returns',{method:'POST',write:true,body:{workPlanId:button.dataset.proposeTime,humanActiveMinutes:Number(raw)}});return load();
  }
  if(button.dataset.time){
    if(!confirm(button.dataset.decision==='confirmed'?'确认这段时间确实被返还？':'确认不计入这条记录？'))return;
    await api('/api/time-returns/'+encodeURIComponent(button.dataset.time)+'/decision',{method:'POST',write:true,body:{decision:button.dataset.decision}});return load();
  }
  if(button.dataset.trigger){
    const enabled=button.dataset.enable==='true';
    if(!confirm(enabled?'启用后会按配方生成受控计划，继续受审批和预算门禁。确认启用？':'确认停用这个主动触发器？'))return;
    await api('/api/triggers/'+encodeURIComponent(button.dataset.trigger)+'/enabled',{method:'POST',write:true,body:{enabled}});return load();
  }
  if(button.dataset.triggerRecipe){
    const recipe=state.recipes.find(item=>item.id===button.dataset.triggerRecipe);const values={};
    for(const input of recipe.inputs){const value=prompt(input.description);if(value==null)return;values[input.name]=input.type==='number'?Number(value):input.type==='boolean'?value==='true':input.type==='string_list'?value.split(',').map(item=>item.trim()).filter(Boolean):value}
    const startsAt=prompt('首次运行时间（ISO 8601 UTC，例如 2026-08-13T01:00:00.000Z）');if(!startsAt)return;
    const intervalMinutes=Number(prompt('间隔分钟数（5 到 43200）','1440'));if(!Number.isSafeInteger(intervalMinutes))return;
    const requesterId=prompt('使用哪个项目请求人账号？留空时单请求人项目会自动选择。')||undefined;
    const id=(button.dataset.project+'-'+button.dataset.triggerRecipe+'-'+Date.now()).toLowerCase().replace(/[^a-z0-9._-]+/g,'-').slice(0,100);
    await api('/api/triggers',{method:'POST',write:true,body:{id,projectId:button.dataset.project,recipeId:button.dataset.triggerRecipe,requesterId,kind:'schedule',values,schedule:{startsAt,intervalMinutes}}});alert('触发器已保存为停用状态。检查后再单独启用。');return load();
  }
  if(button.dataset.recipe){
    const recipe=state.recipes.find(item=>item.id===button.dataset.recipe);const values={};
    for(const input of recipe.inputs){const value=prompt(input.description);if(value==null)return;values[input.name]=input.type==='number'?Number(value):input.type==='boolean'?value==='true':input.type==='string_list'?value.split(',').map(item=>item.trim()).filter(Boolean):value}
    await api('/api/projects/'+encodeURIComponent(button.dataset.project)+'/recipes/'+encodeURIComponent(button.dataset.recipe)+'/instantiate',{method:'POST',write:true,body:{values}});
    alert('已生成受控工作计划；请到运维管理页审核或查看执行状态。');
  }
};
</script>
</body>
</html>`;

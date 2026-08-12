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
let state={projects:[],recipes:[],timeReturns:[],triggers:[]};
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
function projectDetails(project){
  const work=(project.plans.items||[]).slice(0,5).map(item=>'<li><span class="pill">'+escapeHtml(item.status)+'</span> '+escapeHtml(item.objective)+' · '+item.steps.completed+'/'+item.steps.total+' 步</li>').join('');
  const memory=(project.memory.items||[]).slice(0,5).map(item=>'<li>'+escapeHtml(item.factKey||'project.fact')+'：'+escapeHtml(item.statement)+'</li>').join('');
  const deliverables=(project.deliverables||[]).slice(0,5).map(item=>'<li>'+escapeHtml(item.capability)+' · '+escapeHtml(item.kind||'evidence')+(item.reference?' · '+escapeHtml(item.reference):'')+'</li>').join('');
  return '<div class="form"><div><h3>近期工作</h3>'+(work?'<ul>'+work+'</ul>':'<p class="hint">暂无工作计划</p>')+'</div><div><h3>项目记忆</h3>'+(memory?'<ul>'+memory+'</ul>':'<p class="hint">暂无经确认记忆</p>')+'</div><div class="wide"><h3>交付物证据</h3>'+(deliverables?'<ul>'+deliverables+'</ul>':'<p class="hint">暂无已验收交付物</p>')+'</div></div>';
}
function projectCard(project){
  return '<article class="card"><div class="row"><div><h2>'+escapeHtml(project.name)+'</h2><p>'+escapeHtml(project.objective||'尚未设置目标')+'</p></div><span class="pill">'+project.plans.active+' 个进行中</span></div><div class="grid"><div class="metric">里程碑<strong>'+project.milestones.length+'</strong></div><div class="metric">正式记忆<strong>'+project.memory.confirmed+'</strong></div><div class="metric">决策 / 风险<strong>'+project.memory.decisions+' / '+project.memory.risks+'</strong></div><div class="metric">返还时间<strong>'+project.timeReturn.returnedHours+'h</strong></div></div>'+projectDetails(project)+'<h3>可用配方</h3>'+recipeCards(project)+'<h3>主动工作</h3>'+triggerRows(project)+timeReturnCandidates(project)+'<p class="hint">成功标准：'+escapeHtml(project.successCriteria.join('；')||'尚未设置')+'</p></article>';
}
function render(){
  const confirmed=state.timeReturns.filter(item=>item.status==='confirmed');
  const proposed=state.timeReturns.filter(item=>item.status==='proposed');
  const returnedMinutes=confirmed.reduce((sum,item)=>sum+item.returnedMinutes,0);
  byId('summary').innerHTML=[['项目',state.projects.length],['已完成计划',state.projects.reduce((sum,item)=>sum+item.plans.completed,0)],['待确认返还',proposed.length],['已返还小时',Math.round(returnedMinutes/6)/10]].map(item=>'<div class="metric">'+item[0]+'<strong>'+item[1]+'</strong></div>').join('');
  byId('projects').innerHTML=state.projects.map(projectCard).join('')||'<div class="empty">还没有项目。点击“接入项目”，10 分钟内完成目标、记忆范围、配方和安全默认能力配置。</div>';
  if(proposed.length)byId('projects').insertAdjacentHTML('afterbegin','<article class="card"><h2>待确认的时间返还</h2>'+proposed.map(item=>'<p><strong>'+item.returnedMinutes+' 分钟</strong> · '+escapeHtml(item.recipeId)+' <button class="btn" data-time="'+escapeHtml(item.id)+'" data-decision="confirmed">确认</button> <button class="btn" data-time="'+escapeHtml(item.id)+'" data-decision="rejected">不计入</button></p>').join('')+'<p class="hint">只有完整回读证据与本人确认都成立，才计入总数。</p></article>');
}
async function load(){
  const result=await Promise.all([api('/api/projects'),api('/api/recipes'),api('/api/time-returns'),api('/api/triggers')]);
  state={projects:result[0].items,recipes:result[1].items,timeReturns:result[2].items,triggers:result[3].items};
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

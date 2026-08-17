export const personalDashboardHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Foursday 个人工作台</title>
  <style nonce="__NONCE__">
    :root{--bg:#f4f2ec;--paper:#fffdf8;--ink:#17201c;--muted:#65706b;--line:#ddd9cf;--green:#155f49;--soft:#e5f0ea;--amber:#8b5b13;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}button,input,textarea,select{font:inherit}.shell{max-width:1180px;margin:auto;padding:32px 24px 80px}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:24px}.top h1{margin:0 0 6px;font-size:32px}.sub,.hint{color:var(--muted)}.toolbar{display:flex;gap:8px;flex-wrap:wrap}.btn{border:1px solid var(--line);border-radius:9px;background:var(--paper);padding:9px 14px;color:var(--ink);cursor:pointer;text-decoration:none}.btn:hover{border-color:var(--green)}.btn:disabled{cursor:not-allowed;opacity:.55}.btn.primary{background:var(--green);border-color:var(--green);color:white}.btn:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #2f7f6699;outline-offset:2px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.metric,.card{background:var(--paper);border:1px solid var(--line);border-radius:14px}.metric{padding:18px}.metric strong{display:block;font-size:28px;margin-top:8px}.card{padding:20px;margin:14px 0}.card h2,.card h3{margin-top:0}.row{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.pill{display:inline-block;background:var(--soft);color:var(--green);border-radius:999px;padding:4px 9px;font-size:12px}.recipes{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.recipe{border:1px solid var(--line);border-radius:10px;padding:14px}.evidence-preview{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;background:#f7f5ef;border:1px solid var(--line);border-radius:8px;padding:12px;line-height:1.55}.form{display:grid;grid-template-columns:1fr 1fr;gap:12px}.field{display:block}.field span{display:block;color:var(--muted);font-size:13px;margin-bottom:6px}.field input,.field textarea,.field select{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:#fff}.check{display:flex;gap:8px;align-items:flex-start}.wide{grid-column:1/-1}.hidden{display:none}.empty{padding:36px;text-align:center;color:var(--muted)}dialog{border:0;padding:0;background:transparent;width:min(760px,calc(100vw - 32px))}dialog::backdrop{background:#17201c99}.handoff-actions{position:sticky;bottom:-20px;z-index:2;margin-top:16px;padding:12px 0 20px;background:var(--paper);border-top:1px solid var(--line)}@media(max-width:760px){.grid,.recipes,.form{grid-template-columns:1fr}.top{display:block}.toolbar{margin-top:14px}.wide{grid-column:auto}.handoff-actions{bottom:-20px}}
  </style>
</head>
<body>
<main class="shell">
  <header class="top">
    <div><h1>你的 Foursday</h1><div class="sub">目标、配方、项目记忆和真正返还的时间</div></div>
    <div class="toolbar"><a class="btn" href="/">运维管理</a><button id="refresh" class="btn authenticated-control hidden">刷新</button><button id="import-history" class="btn authenticated-control hidden">导入历史项目</button><button id="setup" class="btn primary authenticated-control hidden">接入项目</button><button id="logout" class="btn authenticated-control hidden">退出</button></div>
  </header>
  <section id="auth-loading" class="card"><p class="hint">正在检查本机账户…</p></section>
  <section id="registration" class="card hidden">
    <h2>先创建本机账户</h2>
    <p class="hint">Foursday 只创建一个所有者账户。前往运维管理完成用户名或邮箱、两次密码确认和一次所有权验证后，这里会自动共享登录状态。</p>
    <a class="btn primary" href="/">创建本机账户</a>
  </section>
  <section id="login" class="card hidden">
    <h2>进入个人工作台</h2>
    <p class="hint">使用同一个本机账户登录；运维管理和项目驾驶舱共享短期会话。</p>
    <div class="form"><label class="field"><span>用户名或邮箱</span><input id="login-identifier" autocomplete="username" aria-describedby="login-error" autofocus></label><label class="field"><span>密码</span><input id="login-password" type="password" autocomplete="current-password" aria-describedby="login-error"></label></div>
    <p><button id="enter" class="btn primary">进入</button></p>
    <details><summary class="hint">使用兼容令牌登录</summary><div class="form"><label class="field"><span>只读令牌</span><input id="read" type="password" autocomplete="off"></label><label class="field"><span>写入令牌</span><input id="write" type="password" autocomplete="off"></label></div><p><button id="token-enter" class="btn">使用令牌进入</button></p></details>
    <p id="login-error" class="hint" role="alert"></p>
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
<dialog id="history-import">
  <form method="dialog" class="card">
    <h2>导入历史项目</h2>
    <p class="hint">选择符合公开 Schema 的 JSON 导入包。浏览器只把 JSON 内容发送给本机回环服务；预览会重新读取包中声明的项目内相对路径，不上传整份源文件。</p>
    <label class="field"><span>历史项目导入包（最大 1 MiB）</span><input id="history-file" type="file" accept="application/json,.json"></label>
    <p><button id="preview-history" type="button" class="btn">只读预览</button></p>
    <div id="history-preview" class="hidden"></div>
    <label id="history-confirm-field" class="field hidden"><span>输入预览给出的确认值</span><input id="history-confirmation" autocomplete="off"></label>
    <p class="hint">显式应用最多创建项目清单和待审记忆候选；不会确认记忆、运行配方、发送消息或修改外部系统。</p>
    <div class="toolbar"><button value="cancel" class="btn">取消</button><button id="apply-history" type="button" class="btn primary" disabled>确认导入待审候选</button></div>
  </form>
</dialog>
<dialog id="memory-settings">
  <form method="dialog" class="card">
    <h2>设置项目记忆范围</h2>
    <p class="hint">这里只修改当前项目的记忆授权，不会开启全局能力、发送消息、运行计划或立即调用模型；工作台不会替你扩大权限。</p>
    <div class="form">
      <label class="field"><span>同步模式</span><select id="memory-settings-mode"><option value="disabled">关闭</option><option value="approval_required">每次应用需确认</option><option value="automatic">来源变化后自动形成候选</option></select></label>
      <label class="field"><span>授权到期时间（最长 365 天）</span><input id="memory-settings-expiry" type="datetime-local"></label>
      <label class="field wide"><span>固定来源文件（项目内相对路径，每行一个）</span><textarea id="memory-settings-sources" rows="4" placeholder="README.md&#10;docs/decisions.md"></textarea></label>
      <label class="field wide"><span>允许的事实前缀（小写点路径并以 . 结尾，每行一个）</span><textarea id="memory-settings-prefixes" rows="3" placeholder="decision.&#10;principle.&#10;milestone."></textarea></label>
      <label class="field"><span>最长记忆保留天数</span><input id="memory-settings-retention" type="number" min="1" max="365" value="90"></label>
      <label class="check"><input id="memory-settings-auto-confirm" type="checkbox"><span>只对置信度为 1、非敏感、来源未变且无冲突的事实自动确认</span></label>
    </div>
    <p><button id="preview-memory-settings" type="button" class="btn">只读检查来源与权限变化</button></p>
    <div id="memory-settings-preview" class="hidden"></div>
    <label id="memory-settings-confirm-field" class="field hidden"><span>输入预览给出的确认值</span><input id="memory-settings-confirmation" autocomplete="off"></label>
    <p class="hint">预览会读取并摘要固定来源，但不返回文件正文。应用只原子更新项目清单；全局能力关闭时，自动同步仍不会运行。</p>
    <div class="toolbar"><button value="cancel" class="btn">取消</button><button id="apply-memory-settings" type="button" class="btn primary" disabled>应用精确授权</button></div>
  </form>
</dialog>
<dialog id="memory-sync-preview">
  <form method="dialog" class="card">
    <h2>审阅项目记忆同步</h2>
    <div id="memory-sync-preview-content"></div>
    <label id="memory-sync-confirm-field" class="field hidden"><span>输入预览给出的确认值</span><input id="memory-sync-confirmation" autocomplete="off"></label>
    <p class="hint">生成预览会调用已配置的模型服务，但不会写数据库。应用时重新核对来源和记忆状态；是否自动确认只取决于既有项目授权，不会在这里扩大。</p>
    <div class="toolbar"><button value="cancel" class="btn">取消</button><button id="apply-memory-sync" type="button" class="btn primary">应用当前同步预览</button></div>
  </form>
</dialog>
<dialog id="plan-preview">
  <form method="dialog" class="card">
    <h2>审阅受控计划</h2>
    <div id="plan-preview-content"></div>
    <p class="hint">预览不会写入计划账本。确认登记只保存这份精确哈希的计划，不代表批准，也不会自动执行。</p>
    <div class="toolbar"><button value="cancel" class="btn">取消</button><button id="register-plan" type="button" class="btn primary">确认登记计划</button></div>
  </form>
</dialog>
<dialog id="work-handoff" aria-labelledby="work-handoff-title">
  <form method="dialog" class="card">
    <h2 id="work-handoff-title">工作委托单</h2>
    <p id="work-handoff-description" class="hint"></p>
    <div id="work-handoff-inputs" class="form"></div>
    <div id="work-handoff-schedule" class="form hidden">
      <h3 class="wide">主动运行条件</h3>
      <label class="field"><span>首次运行时间（本机时间）</span><input id="work-starts-at" type="datetime-local"></label>
      <label class="field"><span>重复间隔（分钟，5～43200）</span><input id="work-interval" type="number" min="5" max="43200" value="1440"></label>
      <label class="field"><span>每天最多生成计划数</span><input id="work-max-runs" type="number" min="1" max="100" value="1"></label>
      <label class="field"><span>两次运行冷却（分钟）</span><input id="work-cooldown" type="number" min="1" max="1440" value="15"></label>
      <label class="field wide"><span>项目请求人账号（单请求人项目可留空）</span><input id="work-requester" autocomplete="off"></label>
    </div>
    <p id="work-handoff-boundary" class="hint"></p>
    <div class="toolbar handoff-actions"><button value="cancel" class="btn">取消</button><button id="preview-handoff" type="button" class="btn primary">生成精确计划预览</button></div>
  </form>
</dialog>
<script nonce="__NONCE__">
const byId=id=>document.getElementById(id);
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
let state={projects:[],recipes:[],timeReturns:[],triggers:[],weeklyDelegation:null};
let pendingPlan=null;
let pendingHistoricalImport=null;
let pendingMemorySync=null;
let pendingMemorySettings=null;
let pendingHandoff=null;
async function api(path,{method='GET',body,write=false,timeoutMs=10000}={}){
  const headers={};const readToken=sessionStorage.getItem('foursday-read');const csrf=sessionStorage.getItem('foursday-csrf');
  if(readToken)headers.Authorization='Bearer '+readToken;
  if(body)headers['Content-Type']='application/json';
  if(method!=='GET'&&csrf)headers['X-Foursday-CSRF']=csrf;
  if(write&&!csrf){const token=sessionStorage.getItem('foursday-write');if(!token)throw new Error('需要写入权限');headers['X-Foursday-Write-Token']=token}
  const response=await fetch(path,{method,headers,credentials:'same-origin',body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeoutMs)});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||'请求失败');
  return result;
}
function recipeCards(project){
  const recipes=project.recipes||[];
  if(!recipes.length)return '<p class="hint">尚未选择配方，可通过受控项目清单更新后再使用。</p>';
  return '<div class="recipes">'+recipes.map(recipe=>'<div class="recipe"><strong>'+escapeHtml(recipe.name)+'</strong><p class="hint">'+escapeHtml(recipe.description)+'</p><button class="btn" data-recipe="'+escapeHtml(recipe.id)+'" data-project="'+escapeHtml(project.projectId)+'">预览受控计划</button> <button class="btn" data-trigger-recipe="'+escapeHtml(recipe.id)+'" data-project="'+escapeHtml(project.projectId)+'">设为定时工作</button></div>').join('')+'</div>';
}
function triggerRows(project){
  const items=state.triggers.filter(item=>item.projectId===project.projectId);
  if(!items.length)return '<p class="hint">尚未设置主动工作。新触发器始终先以停用状态保存。</p>';
  return items.map(item=>'<p><strong>'+escapeHtml(item.id)+'</strong> · '+escapeHtml(item.recipeId)+' · '+escapeHtml(item.kind)+(item.nextRunAt?' · 下次 '+escapeHtml(item.nextRunAt):'')+' <span class="pill">'+escapeHtml(item.status)+'</span> <button class="btn" data-trigger="'+escapeHtml(item.id)+'" data-enable="'+String(item.status!=='enabled')+'">'+(item.status==='enabled'?'停用':'启用')+'</button></p>').join('');
}
function timeReturnCandidates(project){
  const candidates=project.timeReturnCandidates||[];
  if(!candidates.length)return '';
  return '<h3>可核销的已完成工作</h3>'+candidates.map(item=>{const previews=(item.evidencePreviews||[]).map(evidence=>'<details><summary>'+escapeHtml(evidence.capability)+' · '+escapeHtml(evidence.kind)+' · '+escapeHtml(evidence.bytes)+' 字节</summary><pre class="evidence-preview">'+escapeHtml(evidence.content)+(evidence.truncated?'\\n\\n［预览已截断；核销前请在计划证据中查看完整内容］':'')+'</pre><p class="hint">验证：'+escapeHtml(evidence.verification||'未标注')+' · 摘要：'+escapeHtml(evidence.sha256||'未提供')+'</p></details>').join('');return '<article class="recipe"><strong>'+escapeHtml(item.objective)+'</strong><p class="hint">配方基线 '+item.baselineMinutes+' 分钟。先审阅下面的实际交付物，再填写你在 AI 产出后用于阅读、核对、补充和修改的真实分钟数。</p>'+previews+'<p><button class="btn" data-propose-time="'+escapeHtml(item.workPlanId)+'" data-baseline="'+item.baselineMinutes+'">交付物已审阅，填写真实人工投入</button></p></article>'}).join('');
}
function memorySyncBlock(project){
  const sync=project.memorySync||{};
  if(!sync.configured)return '<div class="wide"><h3>项目记忆自动同步</h3><p class="hint">尚未授权。先固定来源文件、事实前缀、保留期和到期时间；预览后再精确确认。</p><p><button class="btn" data-memory-settings="'+escapeHtml(project.projectId)+'">设置项目记忆范围</button></p></div>';
  const labels={not_started:'尚未运行',synchronized:'已同步',unchanged:'来源未变化',review_required:'需要审阅',failed:'同步失败',unknown:'状态未知'};
  const sources=(sync.sourcePaths||[]).map(path=>'<code>'+escapeHtml(path)+'</code>').join('、')||'未配置';
  const policy=sync.mode==='automatic'?(sync.autoConfirm?'低风险事实可自动确认':'只自动形成候选'):'每次应用需摘要确认';
  const timing=sync.lastCheckedAt?'最近检查 '+escapeHtml(sync.lastCheckedAt):'尚无同步记录';
  const evidence=sync.sourceDigestPrefix?' · 来源摘要 '+escapeHtml(sync.sourceDigestPrefix)+'…':'';
  const error=sync.errorCode?' · 错误 '+escapeHtml(sync.errorCode):'';
  const expiry=sync.expired?'授权已过期':sync.expiresAt?'授权到期 '+escapeHtml(sync.expiresAt):'未设置到期时间';
  const global=sync.globalGateEnabled?'全局能力已开放':'全局能力关闭，当前授权不会自动运行';
  const syncAction=sync.authorized?'<button class="btn" data-memory-sync="'+escapeHtml(project.projectId)+'">生成一次同步预览</button> ':'';
  return '<div class="wide"><h3>项目记忆自动同步 <span class="pill">'+escapeHtml(sync.expired?'授权过期':labels[sync.state]||sync.state)+'</span></h3><p>授权来源：'+sources+'</p><p class="hint">策略：'+escapeHtml(policy)+' · '+expiry+' · '+escapeHtml(global)+' · 待审 '+escapeHtml(sync.reviewRequired||0)+' · 本轮确认 '+escapeHtml(sync.memoriesConfirmed||0)+'</p><p class="hint">'+timing+evidence+error+'</p><p>'+syncAction+'<button class="btn" data-memory-settings="'+escapeHtml(project.projectId)+'">修改记忆范围</button></p><p class="hint">设置不会开启全局能力；生成同步预览才会调用模型，且不会发送消息或执行计划。</p></div>';
}
function memoryReviewBlock(project){
  const items=project.memory?.reviewItems||[];if(!items.length)return '';
  const rows=items.map(item=>{
    const source=item.sourcePath?'<code>'+escapeHtml(item.sourcePath)+'</code>':escapeHtml(item.sourceType||'未知来源');
    const conflicts=(item.conflicts||[]).map(existing=>'<div class="recipe"><p><strong>当前正式事实：</strong>'+escapeHtml(existing.statement)+'</p><button class="btn" data-memory-decision="replaced" data-memory-id="'+escapeHtml(item.id)+'" data-supersedes="'+escapeHtml(existing.id)+'">明确用候选替代这条事实</button></div>').join('');
    const duplicates=(item.duplicates||[]).length?'<p class="hint">同一正式记忆已经存在；不能重复确认。</p>':'';
    const confirmAction=item.factKey&&!conflicts&&!duplicates?'<button class="btn" data-memory-decision="confirmed" data-memory-id="'+escapeHtml(item.id)+'">确认成为正式记忆</button> ':'';
    return '<article class="recipe"><p><strong>'+escapeHtml(item.factKey||'缺少事实键')+'</strong>：'+escapeHtml(item.statement)+'</p><p class="hint">'+source+' · '+escapeHtml(item.sensitivity||'internal')+(item.updatedAt?' · '+escapeHtml(item.updatedAt):'')+'</p>'+conflicts+duplicates+'<p>'+confirmAction+'<button class="btn" data-memory-decision="revoked" data-memory-id="'+escapeHtml(item.id)+'">拒绝候选</button></p></article>';
  }).join('');
  return '<div class="wide"><h3>待审项目记忆</h3><p class="hint">确认后才会进入后续工作上下文；冲突必须明确选择要替代的旧事实。</p><div class="recipes">'+rows+'</div></div>';
}
function projectDetails(project){
  const work=(project.plans.items||[]).slice(0,5).map(item=>'<li><span class="pill">'+escapeHtml(item.status)+'</span> '+escapeHtml(item.objective)+' · '+item.steps.completed+'/'+item.steps.total+' 步</li>').join('');
  const memory=(project.memory.items||[]).slice(0,5).map(item=>'<li>'+escapeHtml(item.factKey||'project.fact')+'：'+escapeHtml(item.statement)+'</li>').join('');
  const deliverables=(project.deliverables||[]).slice(0,5).map(item=>'<li>'+escapeHtml(item.capability)+' · '+escapeHtml(item.kind||'evidence')+(item.reference?' · '+escapeHtml(item.reference):'')+'</li>').join('');
  const graph=project.governedGraph||{};
  const graphRows=(graph.explanations||[]).slice(0,5).map(item=>'<li>'+escapeHtml(item.planId)+' · 执行对齐：<span class="pill">'+escapeHtml(item.drift.status)+'</span> · 项目变化：'+escapeHtml(item.changes.status)+'</li>').join('');
  const graphBlock=graph.available?'<div class="wide"><h3>受治理工作图</h3><p class="hint">'+graph.nodeCount+' 个节点 · '+graph.edgeCount+' 条关系 · 对齐 '+graph.alignedPlans+' · 偏离 '+graph.driftedPlans+' · 证据不完整 '+graph.incompletePlans+'</p>'+(graphRows?'<ul>'+graphRows+'</ul>':'<p class="hint">尚无可解释的计划投影。</p>')+'<p class="hint">这里仅解释已有证据；授权、预算和审批仍以领域账本为准。</p></div>':'';
  return '<div class="form"><div><h3>近期工作</h3>'+(work?'<ul>'+work+'</ul>':'<p class="hint">暂无工作计划</p>')+'</div><div><h3>项目记忆</h3>'+(memory?'<ul>'+memory+'</ul>':'<p class="hint">暂无经确认记忆</p>')+'<p class="hint">待审候选 '+escapeHtml(project.memory.proposed||0)+' · 冲突 '+escapeHtml(project.memory.conflictsPendingReview||0)+'</p></div>'+memoryReviewBlock(project)+memorySyncBlock(project)+'<div class="wide"><h3>交付物证据</h3>'+(deliverables?'<ul>'+deliverables+'</ul>':'<p class="hint">暂无已验收交付物</p>')+'</div>'+graphBlock+'</div>';
}
function projectCard(project){
  const coverage=project.timeReturn.weeklyAutomationCoverage==null?'—':Math.round(project.timeReturn.weeklyAutomationCoverage*1000)/10+'%';
  return '<article class="card"><div class="row"><div><h2>'+escapeHtml(project.name)+'</h2><p>'+escapeHtml(project.objective||'尚未设置目标')+'</p></div><span class="pill">'+project.plans.active+' 个进行中</span></div><div class="grid"><div class="metric">里程碑<strong>'+project.milestones.length+'</strong></div><div class="metric">正式记忆<strong>'+project.memory.confirmed+'</strong></div><div class="metric">决策 / 风险<strong>'+project.memory.decisions+' / '+project.memory.risks+'</strong></div><div class="metric">本周返还<strong>'+project.timeReturn.weeklyReturnedHours+'h</strong></div><div class="metric">本周已验证自动化率<strong>'+coverage+'</strong></div></div>'+projectDetails(project)+'<h3>可用配方</h3>'+recipeCards(project)+'<h3>主动工作</h3>'+triggerRows(project)+timeReturnCandidates(project)+'<p class="hint">本周从周一开始；自动化率只统计本周有完整证据并经本人确认的配方基线，不代表全部工作。来源：生产计划 '+escapeHtml(project.timeReturnSources?.workPlans||0)+' 条，已确认影子证据 '+escapeHtml(project.timeReturnSources?.shadowEvidence||0)+' 条。</p><p class="hint">成功标准：'+escapeHtml(project.successCriteria.join('；')||'尚未设置')+'</p></article>';
}
function weeklyDelegationCard(){
  const weekly=state.weeklyDelegation;if(!weekly)return '';
  const hours=Math.round(weekly.remainingMinutes/6)/10;
  const projected=Math.round(weekly.projectedVerifiedReturnedMinutes/6)/10;
  if(weekly.targetMet)return '<article class="card"><h2>本周工作返还队列</h2><p><span class="pill">本周目标已完成</span> 已返还 '+Math.round(weekly.weeklyReturnedMinutes/6)/10+' 小时。</p><p class="hint">队列不会为了增加数字而重复推荐工作。</p></article>';
  const rows=(weekly.items||[]).slice(0,8).map(item=>{
    const evidence=item.evidenceStatus==='verified_history'?'保守预计返还 '+Math.round(item.conservativeReturnedMinutes/6)/10+'h · '+item.evidenceSamples+' 条本人确认记录':'尚无本人确认的返还记录 · 本次只用于验证基线';
    const gate=weekly.executionEnabled?(item.approvalRequired?' · 需要审批':' · 可按项目策略进入计划'):' · 计划执行仍关闭';
    return '<div class="recipe"><strong>'+escapeHtml(item.projectName)+' · '+escapeHtml(item.recipeName)+'</strong><p class="hint">'+escapeHtml(evidence+gate)+'</p><button class="btn" data-recipe="'+escapeHtml(item.recipeId)+'" data-project="'+escapeHtml(item.projectId)+'">预览受控计划</button></div>';
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
function renderPlanPreview(preview){
  const decision=preview.approvalRequired?'登记后仍需人工审批':'登记后进入项目策略允许的待执行队列';
  const execution=preview.execution.enabled?'全局执行能力已开启，但本次预览和登记都不会启动执行':'全局计划执行当前关闭';
  const steps=preview.steps.map((step,index)=>'<li><strong>'+(index+1)+'. '+escapeHtml(step.description)+'</strong><br><span class="pill">'+escapeHtml(step.level)+' · '+escapeHtml(step.capability)+' · '+escapeHtml(step.mode)+'</span> '+(step.sideEffect?'<span class="pill">有副作用</span>':'<span class="pill">只读</span>')+'<br><span class="hint">验收证据：'+escapeHtml(step.expectedEvidence)+'</span></li>').join('');
  byId('plan-preview-content').innerHTML='<p><strong>'+escapeHtml(preview.recipe.name)+'</strong> · '+escapeHtml(preview.objective)+'</p><p><span class="pill">'+escapeHtml(preview.maxLevel)+'</span> '+escapeHtml(decision)+'</p><ol>'+steps+'</ol><p class="hint">策略结论：'+escapeHtml(preview.reason)+'；'+escapeHtml(execution)+'。</p><p class="hint">精确计划哈希：<code>'+escapeHtml(preview.planHash)+'</code></p>';
}
function recipeInputField(input,index){
  const id='work-input-'+index;const required=input.required?' required':'';
  if(input.type==='boolean')return '<label class="field"><span>'+escapeHtml(input.description)+'</span><select id="'+id+'" data-recipe-input="'+escapeHtml(input.name)+'" data-input-type="boolean"'+required+'><option value="true">是</option><option value="false">否</option></select></label>';
  if(input.type==='number')return '<label class="field"><span>'+escapeHtml(input.description)+'</span><input id="'+id+'" data-recipe-input="'+escapeHtml(input.name)+'" data-input-type="number" type="number" step="any"'+required+'></label>';
  const list=input.type==='string_list';
  return '<label class="field '+(list?'':'wide')+'"><span>'+escapeHtml(input.description)+(list?'（每行或逗号分隔）':'')+'</span><textarea id="'+id+'" data-recipe-input="'+escapeHtml(input.name)+'" data-input-type="'+escapeHtml(input.type)+'" rows="'+(list?'3':'4')+'"'+required+'></textarea></label>';
}
function openWorkHandoff(projectId,recipeId,mode){
  const project=state.projects.find(item=>item.projectId===projectId);const recipe=state.recipes.find(item=>item.id===recipeId);if(!project||!recipe){alert('项目或配方已变化，请刷新后重试。');return}
  pendingHandoff={projectId,recipeId,mode};
  byId('work-handoff-title').textContent=mode==='schedule'?'设置停用的主动工作':'把工作交给 Foursday';
  byId('work-handoff-description').textContent=project.name+' · '+recipe.name+'：'+recipe.description;
  byId('work-handoff-inputs').innerHTML=recipe.inputs.map(recipeInputField).join('');
  byId('work-handoff-schedule').classList.toggle('hidden',mode!=='schedule');
  byId('work-starts-at').value=localDateTimeValue(new Date(Date.now()+60*60*1000).toISOString());
  byId('work-interval').value='1440';byId('work-max-runs').value='1';byId('work-cooldown').value='15';byId('work-requester').value='';
  byId('work-handoff-boundary').textContent=mode==='schedule'?'先审阅同一输入形成的配方计划；保存后触发器仍为停用状态，未来每次运行会生成新的运行键和计划哈希，并继续经过项目授权、预算和审批。':'本步骤只生成零写入计划预览；登记精确哈希是下一项独立动作，登记也不代表批准或执行。';
  byId('preview-handoff').textContent=mode==='schedule'?'审阅配方并准备停用触发器':'生成精确计划预览';
  byId('work-handoff').showModal();
}
function readHandoffValues(){
  const values={};
  for(const field of byId('work-handoff-inputs').querySelectorAll('[data-recipe-input]')){
    const raw=field.value.trim();if(field.required&&!raw)throw new Error('请填写：'+field.closest('label').querySelector('span').textContent);
    const type=field.dataset.inputType;
    values[field.dataset.recipeInput]=type==='number'?Number(raw):type==='boolean'?raw==='true':type==='string_list'?raw.split(/[\\n,]/u).map(item=>item.trim()).filter(Boolean):raw;
  }
  return values;
}
function renderHistoricalImportPreview(preview){
  const action=preview.project.action==='create'?'将创建项目清单':'将复用同一项目清单';
  const candidates=preview.candidates.map(item=>'<li><strong>'+escapeHtml(item.factKey)+'</strong>：'+escapeHtml(item.statement)+'<br><span class="hint">'+escapeHtml(item.type)+' · '+escapeHtml(item.sensitivity)+' · 来源 '+escapeHtml(item.sourcePath)+' · 保留 '+escapeHtml(item.retentionDays)+' 天'+(item.duplicate?' · 已有重复':item.conflictCount?' · 与 '+escapeHtml(item.conflictCount)+' 条正式记忆冲突':'')+'</span></li>').join('');
  const skipped=preview.skipped.length?'<p class="hint">安全跳过 '+preview.skipped.length+' 条：'+preview.skipped.map(item=>'#'+(item.index+1)+' '+item.reasons.map(escapeHtml).join('/')).join('；')+'</p>':'';
  byId('history-preview').innerHTML='<h3>'+escapeHtml(preview.project.name)+'</h3><p><span class="pill">'+escapeHtml(action)+'</span> 来源 '+escapeHtml(preview.counts.sources)+' 个 · 可导入候选 '+escapeHtml(preview.counts.candidates)+' 条 · 重复 '+escapeHtml(preview.counts.duplicates)+' 条 · 冲突 '+escapeHtml(preview.counts.conflicts)+' 条</p>'+(candidates?'<ol>'+candidates+'</ol>':'<p class="hint">没有新的可导入候选。</p>')+skipped+'<p class="hint">导入摘要：<code>'+escapeHtml(preview.digest)+'</code></p><p><strong>确认值：<code>'+escapeHtml(preview.confirmation)+'</code></strong></p>';
  byId('history-preview').classList.remove('hidden');byId('history-confirm-field').classList.remove('hidden');byId('apply-history').disabled=false;
}
function renderMemorySyncPreview(preview){
  const candidates=preview.candidates.map(item=>'<li><strong>'+escapeHtml(item.factKey)+'</strong>：'+escapeHtml(item.statement)+'<br><span class="hint">来源 '+escapeHtml(item.sourcePath)+' · '+escapeHtml(item.sensitivity)+(item.conflictCount?' · 冲突 '+escapeHtml(item.conflictCount)+' 条':item.duplicate?' · 已有重复':'')+'</span></li>').join('');
  const automatic=preview.automaticConfirmationAuthorized?'既有授权允许其中 '+preview.autoConfirmEligible+' 条低风险无冲突事实在应用时自动确认':'应用后全部保持待审候选';
  byId('memory-sync-preview-content').innerHTML='<p><span class="pill">模型已调用</span> '+escapeHtml(preview.generatedBy)+' · 生成摘要 '+escapeHtml(preview.generatedArtifactSha256.slice(0,12))+'…</p><p>候选 '+escapeHtml(preview.counts.candidates)+' 条 · 跳过 '+escapeHtml(preview.counts.skipped)+' 条 · 冲突 '+escapeHtml(preview.counts.conflicts)+' 条</p>'+(candidates?'<ol>'+candidates+'</ol>':'<p class="hint">没有新的候选。</p>')+'<p class="hint">'+escapeHtml(automatic)+'；预览将在 '+escapeHtml(preview.expiresAt)+' 失效。</p>'+(preview.confirmationRequired?'<p><strong>确认值：<code>'+escapeHtml(preview.confirmation)+'</code></strong></p>':'');
  byId('memory-sync-confirm-field').classList.toggle('hidden',!preview.confirmationRequired);byId('memory-sync-confirmation').value='';
}
function linesFrom(id){return byId(id).value.split('\\n').map(value=>value.trim()).filter(Boolean)}
function localDateTimeValue(iso){const date=iso?new Date(iso):new Date(Date.now()+90*86400000);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16)}
function openMemorySettings(project){
  const sync=project.memorySync||{};pendingMemorySettings={projectId:project.projectId,preview:null};
  byId('memory-settings-mode').value=sync.configured?sync.mode:'approval_required';
  byId('memory-settings-expiry').value=localDateTimeValue(sync.expiresAt);
  byId('memory-settings-sources').value=(sync.sourcePaths||[]).join('\\n');
  byId('memory-settings-prefixes').value=(sync.allowedFactKeyPrefixes||['decision.','principle.','milestone.']).join('\\n');
  byId('memory-settings-retention').value=String(sync.maxRetentionDays||project.memoryScope?.retentionDays||90);
  byId('memory-settings-auto-confirm').checked=sync.autoConfirm===true;
  byId('memory-settings-preview').classList.add('hidden');byId('memory-settings-preview').innerHTML='';
  byId('memory-settings-confirm-field').classList.add('hidden');byId('memory-settings-confirmation').value='';byId('apply-memory-settings').disabled=true;
  byId('memory-settings').showModal();
}
function memorySettingsPayload(){
  const mode=byId('memory-settings-mode').value;
  return {mode,sourcePaths:linesFrom('memory-settings-sources'),allowedFactKeyPrefixes:linesFrom('memory-settings-prefixes'),maxRetentionDays:Number(byId('memory-settings-retention').value),autoConfirm:byId('memory-settings-auto-confirm').checked,expiresAt:mode==='disabled'?null:new Date(byId('memory-settings-expiry').value).toISOString()};
}
function renderMemorySettingsPreview(preview){
  const sourceRows=preview.sources.map(item=>'<li><code>'+escapeHtml(item.path)+'</code> · '+escapeHtml(item.bytes)+' 字节 · '+escapeHtml(item.sha256.slice(0,12))+'…</li>').join('');
  const expansion=preview.changes.authorizationExpansion?'<span class="pill">授权范围扩大</span>':'<span class="pill">未扩大授权范围</span>';
  const effect=preview.effectiveAutomaticConfirmation?'全局能力已开放；应用后，符合全部低风险门禁的事实可自动确认':preview.effectiveAutomaticSync?'全局能力已开放；来源变化后只自动形成候选':'全局能力关闭；应用后不会自动同步';
  byId('memory-settings-preview').innerHTML='<h3>精确授权预览</h3><p>'+expansion+' 模式：'+escapeHtml(preview.current.mode)+' → '+escapeHtml(preview.proposed.mode)+'</p>'+(sourceRows?'<ul>'+sourceRows+'</ul>':'<p class="hint">应用后关闭项目记忆同步。</p>')+'<p class="hint">事实前缀：'+escapeHtml(preview.proposed.allowedFactKeyPrefixes.join('、')||'无')+' · 保留 '+escapeHtml(preview.proposed.maxRetentionDays||0)+' 天 · 到期 '+escapeHtml(preview.proposed.expiresAt||'立即关闭')+'</p><p><strong>'+escapeHtml(effect)+'</strong></p><p>确认值：<code>'+escapeHtml(preview.confirmation)+'</code></p><p class="hint">清单摘要：'+escapeHtml(preview.nextManifestSha256.slice(0,12))+'… · 来源摘要：'+escapeHtml(preview.sourceDigest.slice(0,12))+'…</p>';
  byId('memory-settings-preview').classList.remove('hidden');byId('memory-settings-confirm-field').classList.remove('hidden');byId('memory-settings-confirmation').value='';byId('apply-memory-settings').disabled=false;
}
async function load(){
  const result=await Promise.all([api('/api/projects'),api('/api/recipes'),api('/api/time-returns'),api('/api/triggers')]);
  state={projects:result[0].items,weeklyDelegation:result[0].weeklyDelegation,recipes:result[1].items,timeReturns:result[2].items,triggers:result[3].items};
  render();
}
function migrateLegacyTokens(){if(!sessionStorage.getItem('foursday-read')&&sessionStorage.getItem('ai-read'))sessionStorage.setItem('foursday-read',sessionStorage.getItem('ai-read'));if(!sessionStorage.getItem('foursday-write')&&sessionStorage.getItem('ai-write'))sessionStorage.setItem('foursday-write',sessionStorage.getItem('ai-write'))}
function clearBrowserTokens(){['foursday-read','foursday-write','ai-read','ai-write'].forEach(key=>sessionStorage.removeItem(key))}
function showAuthenticated(){byId('auth-loading').classList.add('hidden');byId('registration').classList.add('hidden');byId('login').classList.add('hidden');byId('app').classList.remove('hidden');document.querySelectorAll('.authenticated-control').forEach(item=>item.classList.remove('hidden'))}
function showLoggedOut(){byId('auth-loading').classList.add('hidden');byId('registration').classList.add('hidden');byId('app').classList.add('hidden');byId('login').classList.remove('hidden');byId('login-identifier').focus()}
function showRegistration(){byId('auth-loading').classList.add('hidden');byId('login').classList.add('hidden');byId('app').classList.add('hidden');byId('registration').classList.remove('hidden')}
function showLoginError(error){const names={invalid_credentials:'用户名、邮箱或密码不正确',too_many_login_attempts:'登录失败次数过多，请稍后再试',password_login_unavailable:'尚未配置密码登录，请暂时使用兼容令牌',browser_origin_required:'只能从当前本机页面登录'};byId('login-error').textContent=names[error.message]||error.message}
byId('enter').onclick=async()=>{try{const response=await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:byId('login-identifier').value,password:byId('login-password').value})});const result=await response.json();if(!response.ok)throw new Error(result.error||'登录失败');sessionStorage.setItem('foursday-csrf',result.csrfToken);clearBrowserTokens();byId('login-password').value='';showAuthenticated();await load()}catch(error){showLoginError(error)}};
byId('token-enter').onclick=async()=>{sessionStorage.removeItem('foursday-csrf');sessionStorage.setItem('foursday-read',byId('read').value);sessionStorage.setItem('foursday-write',byId('write').value);try{await load();showAuthenticated()}catch(error){showLoginError(error)}};
byId('login-password').addEventListener('keydown',event=>{if(event.key==='Enter')byId('enter').click()});
byId('logout').onclick=async()=>{const csrf=sessionStorage.getItem('foursday-csrf');if(csrf){await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Foursday-CSRF':csrf},body:'{}'}).catch(()=>{})}sessionStorage.removeItem('foursday-csrf');clearBrowserTokens();document.querySelectorAll('.authenticated-control').forEach(item=>item.classList.add('hidden'));showLoggedOut()};
async function restoreSession(){try{const response=await fetch('/api/auth/session',{credentials:'same-origin'});if(!response.ok)return false;const result=await response.json();sessionStorage.setItem('foursday-csrf',result.csrfToken);showAuthenticated();await load();return true}catch{return false}}
async function bootstrapAuth(){migrateLegacyTokens();if(await restoreSession())return;try{const response=await fetch('/api/auth/methods',{credentials:'same-origin'});const methods=await response.json();if(response.ok&&methods.registrationAvailable===true)return showRegistration()}catch{}showLoggedOut()}
byId('refresh').onclick=()=>load().catch(error=>alert(error.message));
byId('setup').onclick=()=>{byId('recipe-ids').placeholder=state.recipes.map(item=>item.id).join(', ');byId('wizard').showModal()};
byId('import-history').onclick=()=>{pendingHistoricalImport=null;byId('history-file').value='';byId('history-confirmation').value='';byId('history-preview').classList.add('hidden');byId('history-confirm-field').classList.add('hidden');byId('apply-history').disabled=true;byId('history-import').showModal()};
byId('preview-history').onclick=async()=>{
  const file=byId('history-file').files[0];if(!file){alert('请先选择 JSON 导入包。');return}if(file.size>1024*1024){alert('导入包不能超过 1 MiB。');return}
  let bundle;try{bundle=JSON.parse(await file.text())}catch{alert('导入包不是有效 JSON。');return}
  const preview=await api('/api/projects/import/preview',{method:'POST',body:{bundle}});
  pendingHistoricalImport={bundle,preview};byId('history-confirmation').value='';renderHistoricalImportPreview(preview);
};
byId('apply-history').onclick=async()=>{
  if(!pendingHistoricalImport)return;
  const confirmation=byId('history-confirmation').value.trim();if(confirmation!==pendingHistoricalImport.preview.confirmation){alert('确认值与当前预览不一致。');return}
  const result=await api('/api/projects/import/apply',{method:'POST',write:true,body:{bundle:pendingHistoricalImport.bundle,confirmation}});
  pendingHistoricalImport=null;byId('history-import').close();alert('导入完成：创建 '+result.candidatesCreated+' 条待审候选，正式记忆仍为 0。');await load();
};
byId('apply-memory-sync').onclick=async()=>{
  if(!pendingMemorySync)return;
  const preview=pendingMemorySync.preview;
  const confirmation=byId('memory-sync-confirmation').value.trim();
  if(preview.confirmationRequired&&confirmation!==preview.confirmation){alert('确认值与当前同步预览不一致。');return}
  if(preview.automaticConfirmationAuthorized&&!confirm('该项目此前已经授权低风险、来源未变且无冲突的事实自动确认。继续应用当前预览？'))return;
  const result=await api('/api/projects/'+encodeURIComponent(pendingMemorySync.projectId)+'/memory-sync/apply',{method:'POST',write:true,body:{previewId:preview.previewId,confirmation}});
  pendingMemorySync=null;byId('memory-sync-preview').close();alert('同步完成：创建 '+result.candidatesCreated+' 条候选，自动确认 '+result.memoriesConfirmed+' 条，待审 '+result.reviewRequired+' 条。');await load();
};
byId('preview-memory-settings').onclick=async()=>{
  if(!pendingMemorySettings)return;
  let settings;try{settings=memorySettingsPayload()}catch{alert('请填写有效的授权到期时间。');return}
  const preview=await api('/api/projects/'+encodeURIComponent(pendingMemorySettings.projectId)+'/memory-settings/preview',{method:'POST',write:true,body:{settings}});
  pendingMemorySettings={...pendingMemorySettings,settings,preview};renderMemorySettingsPreview(preview);
};
byId('apply-memory-settings').onclick=async()=>{
  if(!pendingMemorySettings?.preview)return;
  const confirmation=byId('memory-settings-confirmation').value.trim();if(confirmation!==pendingMemorySettings.preview.confirmation){alert('确认值与当前授权预览不一致。');return}
  if(pendingMemorySettings.preview.changes.authorizationExpansion&&!confirm('本次会扩大当前项目的记忆授权范围，但不会开启全局能力。确认应用精确预览？'))return;
  const result=await api('/api/projects/'+encodeURIComponent(pendingMemorySettings.projectId)+'/memory-settings/apply',{method:'POST',write:true,body:{settings:pendingMemorySettings.settings,digest:pendingMemorySettings.preview.digest,confirmation}});
  pendingMemorySettings=null;byId('memory-settings').close();alert(result.effectiveAutomaticSync?'项目授权已更新；全局能力已开放，后续来源变化可进入受控同步。':'项目授权已更新；全局能力仍关闭或模式不是自动，不会自行运行。');await load();
};
byId('create-project').onclick=async event=>{
  event.preventDefault();
  const lines=id=>byId(id).value.split('\\n').map(value=>value.trim()).filter(Boolean);
  await api('/api/projects/onboarding',{method:'POST',write:true,body:{projectId:byId('project-id').value,name:byId('project-name').value,rootDirectory:byId('project-root').value,requesterIds:[byId('requester').value],profile:{objective:byId('objective').value,successCriteria:lines('criteria'),selectedRecipeIds:byId('recipe-ids').value.split(',').map(value=>value.trim()).filter(Boolean),memoryScope:{allowedTypes:['project','principle'],retentionDays:Number(byId('retention').value)}}}});
  byId('wizard').close();await load();
};
byId('preview-handoff').onclick=async()=>{
  if(!pendingHandoff)return;
  let values;try{values=readHandoffValues()}catch(error){alert(error.message);return}
  const preview=await api('/api/projects/'+encodeURIComponent(pendingHandoff.projectId)+'/recipes/'+encodeURIComponent(pendingHandoff.recipeId)+'/preview',{method:'POST',body:{values}});
  if(pendingHandoff.mode==='schedule'){
    let startsAt;try{startsAt=new Date(byId('work-starts-at').value).toISOString()}catch{alert('请填写有效的首次运行时间。');return}
    const intervalMinutes=Number(byId('work-interval').value);const maxRunsPerDay=Number(byId('work-max-runs').value);const cooldownMinutes=Number(byId('work-cooldown').value);
    if(!Number.isSafeInteger(intervalMinutes)||intervalMinutes<5||intervalMinutes>43200){alert('重复间隔必须是 5～43200 分钟的整数。');return}
    if(!Number.isSafeInteger(maxRunsPerDay)||maxRunsPerDay<1||maxRunsPerDay>100){alert('每天最多运行次数必须是 1～100 的整数。');return}
    if(!Number.isSafeInteger(cooldownMinutes)||cooldownMinutes<1||cooldownMinutes>1440){alert('冷却时间必须是 1～1440 分钟的整数。');return}
    const id=(pendingHandoff.projectId+'-'+pendingHandoff.recipeId+'-'+Date.now()).toLowerCase().replace(/[^a-z0-9._-]+/g,'-').slice(0,100);
    pendingPlan={kind:'trigger',trigger:{id,projectId:pendingHandoff.projectId,recipeId:pendingHandoff.recipeId,requesterId:byId('work-requester').value.trim()||undefined,kind:'schedule',values,planHash:preview.planHash,maxRunsPerDay,cooldownMinutes,schedule:{startsAt,intervalMinutes}}};
    renderPlanPreview(preview);byId('plan-preview-content').insertAdjacentHTML('beforeend','<p><strong>主动工作条件：</strong>首次 '+escapeHtml(startsAt)+' · 每 '+escapeHtml(intervalMinutes)+' 分钟 · 每天最多 '+escapeHtml(maxRunsPerDay)+' 次 · 冷却 '+escapeHtml(cooldownMinutes)+' 分钟</p><p class="hint">上面的哈希用于核对当前输入对应的配方计划；触发器保存后仍停用，启用和每次实际运行会重新绑定当时的项目授权并生成新的运行键与计划哈希。</p>');
    byId('register-plan').textContent='保存为停用主动工作';
  }else{
    pendingPlan={kind:'plan',projectId:pendingHandoff.projectId,recipeId:pendingHandoff.recipeId,values,planHash:preview.planHash};
    renderPlanPreview(preview);byId('register-plan').textContent='确认登记计划';
  }
  pendingHandoff=null;byId('work-handoff').close();byId('plan-preview').showModal();
};
byId('projects').onclick=async event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.memoryDecision){
    const decision=button.dataset.memoryDecision;const supersedesId=button.dataset.supersedes||undefined;
    const promptText=decision==='confirmed'?'确认把这条候选转为正式项目记忆？':decision==='replaced'?'确认用候选明确替代所显示的旧正式事实？':'确认拒绝并撤销这条候选？';if(!confirm(promptText))return;
    await api('/api/memories/'+encodeURIComponent(button.dataset.memoryId)+'/decision',{method:'POST',write:true,body:{decision,...(supersedesId?{supersedesId}:{})}});return load();
  }
  if(button.dataset.proposeTime){
    const raw=prompt('请填写你在 AI 交付后实际用于阅读、核对、补充和修改的分钟数（不是假设你从头亲自完成所需时间）。配方基线为 '+button.dataset.baseline+' 分钟；提交后仍需再次确认才计入返还。');if(raw==null)return;
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
  if(button.dataset.memorySync){
    const preview=await api('/api/projects/'+encodeURIComponent(button.dataset.memorySync)+'/memory-sync/preview',{method:'POST',write:true,body:{},timeoutMs:610000});
    pendingMemorySync={projectId:button.dataset.memorySync,preview};renderMemorySyncPreview(preview);byId('memory-sync-preview').showModal();return;
  }
  if(button.dataset.memorySettings){const project=state.projects.find(item=>item.projectId===button.dataset.memorySettings);if(project)openMemorySettings(project);return}
  if(button.dataset.triggerRecipe){openWorkHandoff(button.dataset.project,button.dataset.triggerRecipe,'schedule');return}
  if(button.dataset.recipe){openWorkHandoff(button.dataset.project,button.dataset.recipe,'plan')}
};
byId('register-plan').onclick=async()=>{
  if(!pendingPlan)return;
  const current=pendingPlan;
  if(current.kind==='trigger'){
    const result=await api('/api/triggers',{method:'POST',write:true,body:current.trigger});
    pendingPlan=null;byId('plan-preview').close();alert('主动工作 '+result.id+' 已保存为停用状态；尚未生成或执行计划。');await load();return;
  }
  const result=await api('/api/projects/'+encodeURIComponent(current.projectId)+'/recipes/'+encodeURIComponent(current.recipeId)+'/instantiate',{method:'POST',write:true,body:{values:current.values,planHash:current.planHash}});
  pendingPlan=null;byId('plan-preview').close();
  alert('已登记精确计划 '+result.plan.planHash.slice(0,12)+'…；登记不等于批准或执行。');
  await load();
};
bootstrapAuth();
</script>
</body>
</html>`;

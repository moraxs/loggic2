const paths = {
  overview:'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z',
  accounts:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m8-7.87a4 4 0 0 1 0 7.75',
  models:'m12 2 9 5-9 5-9-5 9-5zm-9 10 9 5 9-5M3 17l9 5 9-5',
  logs:'M5 3h14v18H5zM8 7h8M8 11h8M8 15h5',
  play:'m8 4 13 8-13 8V4Z',code:'m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  refresh:'M20 7a9 9 0 0 0-15-3L2 7m0-5v5h5m-3 10a9 9 0 0 0 15 3l3-3m0 5v-5h-5',
  plus:'M12 5v14M5 12h14',arrow:'M4 12h16m-6-6 6 6-6 6',
  clock:'M12 8v5l3 2m7-3a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  check:'m5 12 4 4L19 6',chart:'M4 3v17h17M8 15l4-5 4 2 5-7',
  close:'m6 6 12 12M6 18 18 6',search:'M21 21l-5-5m2-6a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  upload:'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',download:'M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4',
  lock:'M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4',
  copy:'M9 9h12v12H9zM15 9V3H3v12h6',activity:'M2 12h5l3-8 4 16 3-8h5',
  settings:'M3 7h18M7 3v8M3 17h18m-6-4v8',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.overview}"/></svg>`;
document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const n = value => Number(value || 0).toLocaleString('zh-CN');
const duration = value => value == null ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
const percent = value => value == null ? '—' : `${value.toFixed(1)}%`;
const time = value => value ? new Date(value).toLocaleTimeString('zh-CN', {hour12:false}) : '尚未检测';
const date = value => value ? new Date(value).toLocaleString('zh-CN', {hour12:false}) : '—';
const ago = value => !value ? '尚未检测' : Date.now()-value < 60000 ? '刚刚' : Date.now()-value < 3600000 ? `${Math.floor((Date.now()-value)/60000)} 分钟前` : date(value);
const shortSid = value => value ? `${value.slice(0,10)}…${value.slice(-4)}` : '外部刷新';
const titles = {overview:'代理概览',accounts:'号池管理',models:'模型与性能',logs:'请求日志',playground:'请求测试',connect:'API 接入'};
const statuses = {ready:'可用',pending:'未检测',retry:'待重试',cooling:'冷却中',error:'异常',expired:'已过期',disabled:'已停用',success:'成功',cancelled:'已取消'};
const badge = (status, title='') => `<span class="badge ${esc(status)}" title="${esc(title)}">${statuses[status] || esc(status)}</span>`;
let state, page = location.hash.slice(1) || 'overview', busyCount = 0, loading = false;
let accountQuery = '', accountFilter = 'all', logQuery = '', logFilter = 'all', logPage = 0;
let deleteId, playController, playStarted;
let locked = false;
const busyAccounts = new Set();

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api${path}`, {method, headers:{'X-Logicc-Admin':'1',...(body !== undefined || method === 'POST' ? {'Content-Type':'application/json'} : {})},body:body !== undefined ? JSON.stringify(body) : method === 'POST' ? '{}' : undefined, signal:AbortSignal.timeout(35000)});
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') showLogin();
    throw new Error(result.error?.message || `HTTP ${response.status}`);
  }
  return result;
}
function toast(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast${error?' error':''}`;
  element.textContent = message;
  $('#toasts').append(element);
  while ($('#toasts').children.length > 3) $('#toasts').firstElementChild.remove();
  setTimeout(() => element.remove(), 5000);
}
function errorAt(id, message) { const el = $(id); el.textContent = message; el.hidden = !message; }
async function reload(force = false) {
  if (loading || locked) return;
  loading = true;
  try {
    const nextState = await api('/state');
    if (locked) return;
    state = nextState;
    state.service.baseUrl = `${location.origin}/v1`;
    $('#connection-error').hidden = true;
    $('#connection-state').innerHTML = '<span class="status-dot"></span>代理运行中';
    $('#sidebar-status').textContent = '本地服务在线';
    $('#sidebar-dot').classList.remove('offline');
    $('#sidebar-address').textContent = new URL(state.service.baseUrl).host;
    $('#nav-count').textContent = state.accounts.length;
    $('#last-updated').textContent = `上次同步 ${time(Date.now())}`;
    if (force || (!busyCount && !$('dialog[open]') && !$('details.menu[open]') && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))) render();
  } catch (error) {
    if (locked) return;
    $('#connection-error').textContent = `连接失败：${error.message}。请确认代理仍在运行；5 秒后自动重试。`;
    $('#connection-error').hidden = false;
    $('#connection-state').innerHTML = '<span class="status-dot offline"></span>连接已断开';
    $('#sidebar-status').textContent = '服务连接中断';
    $('#sidebar-dot').classList.add('offline');
    if (!state) $('#main').innerHTML = empty('无法连接代理','请检查启动服务的终端，或点击右上角刷新按钮重试。','activity');
  } finally { loading = false; }
}
function showLogin() {
  locked = true; state = undefined; playController?.abort();
  $('#main').innerHTML = empty('请登录控制台', '使用管理密码登录后查看和管理服务。', 'lock');
  $('#connection-state').textContent = '等待登录';
  $('#nav-count').textContent = '—';
  $('#connection-error').hidden = true;
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('#login-form').reset();
  $('#login-dialog').showModal();
}
$('#login-dialog').addEventListener('cancel', event => event.preventDefault());
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('[type=submit]');
  button.disabled = true; errorAt('#login-error', '');
  try {
    await api('/login', { method: 'POST', body: { password: form.elements.password.value } });
    form.reset(); locked = false; $('#login-dialog').close(); await reload(true);
  } catch (error) { errorAt('#login-error', error.message); }
  finally { button.disabled = false; }
});
const logout = $('#logout');
logout.addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); showLogin(); }
  catch (error) { toast(error.message, true); }
});
const changePassword = $('#change-password');
changePassword.addEventListener('click', () => {
  if (locked) return;
  $('#password-form').reset(); errorAt('#password-error', '');
  $('#password-dialog').showModal();
});
$('#password-dialog').addEventListener('close', () => $('#password-form').reset());
$('#password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('[type=submit]');
  errorAt('#password-error', '');
  if (form.elements.newPassword.value !== form.elements.confirmPassword.value) {
    errorAt('#password-error', '两次输入的新密码不一致'); return;
  }
  button.disabled = true; busyCount++;
  try {
    await api('/settings/admin-password', { method: 'PUT', body: {
      currentPassword: form.elements.currentPassword.value, newPassword: form.elements.newPassword.value,
    } });
    form.reset(); showLogin(); toast('管理密码已保存，请使用新密码重新登录');
  } catch (error) { errorAt('#password-error', error.message); }
  finally { button.disabled = false; busyCount--; }
});
function heading(title, subtitle, actions = '', eyebrow = 'WORKSPACE / LOCAL') {
  return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${actions}</div></div>`;
}
const addButton = `<button class="button primary" data-action="add">${icon('plus')}添加账户</button>`;
const importButton = `<button class="button secondary" data-action="import">${icon('upload')}批量导入</button>`;
const empty = (title, description, symbol = 'accounts', action = '') => `<div class="empty-state">${icon(symbol)}<h3>${title}</h3><p>${description}</p>${action}</div>`;
function metric(label,value,foot,symbol) { return `<div class="metric"><div class="metric-head">${label}${icon(symbol)}</div><div class="metric-value">${value}</div><div class="metric-foot">${foot}</div></div>`; }
function render() {
  if (!state) return;
  if (!titles[page]) page = 'overview';
  $('#breadcrumb-page').textContent = titles[page];
  document.title = `${titles[page]} · Logicc`;
  document.querySelectorAll('[data-page]').forEach(link => { link.classList.toggle('active',link.dataset.page === page); if(link.dataset.page === page) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); });
  if (page === 'playground' && $('#play-form')) return;
  $('#main').innerHTML = ({overview:overviewPage,accounts:accountsPage,models:modelsPage,logs:logsPage,playground:playgroundPage,connect:connectPage})[page]();
}
function chart() {
  const max = Math.max(2, ...state.trend.map(b => b.success+b.error));
  const plot = {x:30,y:10,w:578,h:120};
  const grid = [0,.5,1].map(f => `<line class="grid" x1="30" y1="${10+120*f}" x2="618" y2="${10+120*f}"/><text x="0" y="${13+120*f}">${Math.round(max*(1-f))}</text>`).join('');
  const bars = state.trend.map((bucket,i) => {
    const x = plot.x+i*24.5;
    const h = bucket.success/max*120, e=bucket.error/max*120;
    return `<g><title>${time(bucket.time)} · 成功 ${bucket.success} / 异常 ${bucket.error}</title><rect class="bar" x="${x}" y="${130-h}" width="13" height="${h}" rx="2"/><rect class="bar-error" x="${x}" y="${130-h-e}" width="13" height="${e}" rx="2"/></g>`;
  }).join('');
  const labels = [0,4,8,12,16,20,23].map(i=>`<text x="${plot.x+i*24.5}" y="155" text-anchor="middle">${new Date(state.trend[i].time).getHours().toString().padStart(2,'0')}:00</text>`).join('');
  return `<div class="chart-wrap"><svg class="chart" viewBox="0 0 630 165" preserveAspectRatio="none" role="img" aria-label="过去 24 小时按小时统计的聊天请求：成功 ${state.stats.successes}，异常或取消 ${state.stats.failures}">${grid}${bars}<line class="baseline" x1="30" y1="131" x2="618" y2="131"/>${labels}</svg>${!state.stats.requests?'<div class="chart-empty"><strong>等待第一条请求</strong><span>接入客户端后，流量将在这里显示</span></div>':''}</div>`;
}
function overviewPage() {
  const s=state.stats, total=state.accounts.length, available=s.available;
  const trouble=state.accounts.filter(a=>['error','cooling','expired'].includes(a.status)).length;
  const disabled=state.accounts.filter(a=>a.status==='disabled').length;
  return heading('让每一次请求，都有迹可循。','账号、模型与流量，在一个地方掌握。',`<a class="button secondary" href="#connect">${icon('code')}接入 API</a>${addButton}`,'LOGICC / PROXY OVERVIEW') +
    `<section class="metrics" aria-label="过去24小时运行指标">${metric('可调度账户',`${n(available)}<small>/ ${n(total)}</small>`,`<span class="positive">${available?'调度池已就绪':'等待添加账户'}</span>`,'accounts')}${metric('请求总量',n(s.requests),`过去 24 小时 · ${n(s.active)} 个处理中`,'chart')}${metric('请求成功率',percent(s.successRate),`${n(s.successes)} 次成功 · ${n(s.failures)} 次异常 / 取消`,'check')}${metric('平均首字延迟',s.avgTtft == null?'—':`${(s.avgTtft/1000).toFixed(2)}<small>s</small>`,'首次文本输出 · 含代理开销','clock')}</section>
    <div class="dashboard-grid"><section class="panel"><div class="panel-heading"><div><h2>请求流量</h2><p>流量趋势与请求结果</p></div><div><span class="range-label">近 24 小时</span></div></div>${chart()}<div class="table-footer"><div class="legend"><span><i></i>成功请求</span><span><i class="error"></i>异常 / 取消</span></div><span>按小时汇总 · 本地时间</span></div></section>
    <section class="panel health-panel"><div class="panel-heading"><div><h2>号池状态</h2><p>当前账户可用性</p></div>${icon('accounts')}</div><div class="health-content"><div class="health-ring"><svg viewBox="0 0 110 110" aria-hidden="true"><circle class="ring-base" cx="55" cy="55" r="46"/><circle class="ring-progress" cx="55" cy="55" r="46" stroke-dasharray="${total?available/total*289:0} 289"/></svg><div class="ring-center"><strong>${total?Math.round(available/total*100):0}<span>%</span></strong><span>可调度</span></div></div><div class="health-list"><div><i class="tiny-square"></i>可调度<b>${available.toString().padStart(2,'0')}</b></div><div><i class="tiny-square warn"></i>待处理<b>${trouble.toString().padStart(2,'0')}</b></div><div><i class="tiny-square off"></i>已停用<b>${disabled.toString().padStart(2,'0')}</b></div></div></div><div class="health-footer">${icon('settings')}低并发优先轮询 · 异常自动冷却</div></section></div>
    <section class="panel table-panel"><div class="panel-heading"><div><h2>账户池 <span class="subtle-text">/ ${total.toString().padStart(2,'0')}</span></h2><p>集中管理凭据与调度状态</p></div><a class="text-button" href="#accounts">管理全部${icon('arrow')}</a></div>${accountTable(state.accounts.slice(0,4),true)}<div class="table-footer"><span>${icon('lock')}凭据保存在本机，页面仅显示状态</span><span>${total} 个账户</span></div></section>
    <section class="panel table-panel section-gap"><div class="panel-heading"><div><h2>最近请求</h2><p>查看每次调用的响应与耗时</p></div><a class="text-button" href="#logs">全部日志${icon('arrow')}</a></div>${logTable(state.requests.slice(0,4))}</section>`;
}
function accountTable(accounts,compact=false) {
  if (!accounts.length) return empty(state.accounts.length?'没有匹配的账户':'添加你的第一个账户',state.accounts.length?'试试其他名称、Session ID 或状态。':'添加凭据后检测连接，即可通过 OpenAI 兼容接口发送请求。','accounts',state.accounts.length?'':addButton);
  return `<div class="table-wrap"><table><thead><tr><th>账户</th><th>状态</th><th>认证方式</th><th>请求 / 成功率</th>${compact?'':'<th>上次检测</th>'}<th>操作</th></tr></thead><tbody>${accounts.map((a,i)=>`<tr><td><div class="account-name"><span class="account-avatar">${String(state.accounts.indexOf(a)+1).padStart(2,'0')}</span><div><strong>${esc(a.name)}</strong><small title="${esc(a.sessionId)}">${esc(shortSid(a.sessionId))}</small></div></div></td><td>${badge(a.status,a.lastError || '')}${a.inFlight?`<div class="subtle-text">${a.inFlight} 个处理中</div>`:''}</td><td><span>${a.hasClientCookie?'Client 自动刷新':'Session JWT'}</span>${!compact?`<div class="subtle-text">${a.hasToken&&a.tokenExpiresAt?`JWT ${a.tokenExpiresAt>Date.now()?'有效至 '+time(a.tokenExpiresAt):'待刷新'}`:'按需获取 JWT'}</div>`:''}</td><td><span class="mono">${n(a.requests)}</span><span class="subtle-text"> / ${percent(a.successRate)}</span></td>${compact?'':`<td><span class="subtle-text">${ago(a.lastCheckedAt)}</span>${a.lastError?`<div class="error-text" title="${esc(a.lastError)}">${esc(a.lastError)}</div>`:''}</td>`}<td><div class="row-actions"><button class="text-button" data-action="check" data-id="${a.id}" ${busyAccounts.has(a.id)?'disabled':''}>${busyAccounts.has(a.id)?'检测中…':'检测'}</button><details class="menu"><summary aria-label="${esc(a.name)} 更多操作">⋯</summary><div class="menu-items"><button data-action="edit" data-id="${a.id}">编辑账户</button><button data-action="refresh-token" data-id="${a.id}">刷新凭据</button><button data-action="toggle" data-id="${a.id}">${a.enabled?'暂停调度':'启用账户'}</button><button class="delete" data-action="delete" data-id="${a.id}">移除账户</button></div></details></div></td></tr>`).join('')}</tbody></table></div>`;
}
function accountsPage() {
  return heading('号池管理','管理账户凭据，让请求在可用账户间有序分配。',`${importButton}${addButton}`,'WORKSPACE / ACCOUNTS')+
  `<div class="toolbar"><div class="search-box">${icon('search')}<input id="account-search" aria-label="搜索账户" placeholder="搜索名称或 Session ID…" value="${esc(accountQuery)}"></div><div class="filter-group"><select id="account-filter" aria-label="筛选账户状态">${[['all','全部状态'],['ready','可用'],['pending','未检测'],['cooling','冷却中'],['error','异常 / 过期'],['disabled','已停用']].map(([v,l])=>`<option value="${v}" ${v===accountFilter?'selected':''}>${l}</option>`).join('')}</select><button class="button secondary" data-action="check-all">${icon('activity')}检测全部</button></div></div><section class="panel table-panel"><div id="accounts-table">${filteredAccounts()}</div><div class="table-footer"><span>${icon('settings')}低并发优先轮询 · 凭据错误冷却 5 分钟</span><span>${state.accounts.length} / 200 个账户</span></div></section><p class="security-caption">检测仅获取模型列表，不生成回答。停用账户保留配置；移除账户会删除本地凭据。</p>`;
}
function filteredAccounts() {
  const query=accountQuery.toLowerCase();
  return accountTable(state.accounts.filter(a=>(`${a.name} ${a.sessionId}`.toLowerCase().includes(query)) && (accountFilter==='all' || (accountFilter==='error'?['error','expired'].includes(a.status):a.status===accountFilter))));
}
function modelsPage() {
  const maxLatency=Math.max(1,...state.modelStats.map(m=>m.avgTtft || 0));
  return heading('模型与性能','查看上游可用模型，以及真实调用产生的性能数据。',`<button class="button primary" data-action="sync-models">${icon('refresh')}同步模型</button>`,'WORKSPACE / MODELS')+
  `<section class="panel table-panel"><div class="panel-heading"><div><h2>模型目录 <span class="subtle-text">/ ${state.models.length.toString().padStart(2,'0')}</span></h2><p>${state.modelsUpdatedAt?'最近同步 '+date(state.modelsUpdatedAt):'连接账户后，从上游同步模型目录'}</p></div><span class="range-label">性能 · 近 24 小时</span></div>${!state.models.length?empty('模型目录尚未同步','先在号池中添加并检测账户，或点击「同步模型」。','models'):`<div class="table-wrap"><table><thead><tr><th>模型 ID</th><th>提供方</th><th>调用次数</th><th>成功率</th><th>平均首字延迟</th><th>平均总耗时</th><th></th></tr></thead><tbody>${state.models.map(m=>{const s=state.modelStats.find(s=>s.model===m.id);return `<tr><td><div class="model-name">${esc(m.id)}</div>${m.name!==m.id?`<div class="subtle-text">${esc(m.name)}</div>`:''}</td><td>${esc(m.provider)}</td><td class="mono">${s?n(s.requests):'0'}</td><td>${percent(s?.successRate)}</td><td><div class="latency-bar"><span class="mono">${duration(s?.avgTtft)}</span>${s?.avgTtft!=null?`<span class="latency-track"><i style="width:${s.avgTtft/maxLatency*100}%"></i></span>`:''}</div></td><td class="mono">${duration(s?.avgLatency)}</td><td><button class="text-button" data-action="try-model" data-model="${esc(m.id)}">测试${icon('arrow')}</button></td></tr>`;}).join('')}</tbody></table></div>`}<div class="table-footer"><span>延迟来自本机代理真实请求，包含刷新、建会话与传输开销</span><span>无调用时显示 —</span></div></section><div class="notice"><strong>能力说明</strong><br>支持流式与非流式文本响应，内置搜索与图片工具可透传。自定义函数采用提示词约定，尚不支持标准 tool_calls；当前多轮消息会合并为单条提示词。</div>`;
}
const kindLabel = kind => ({chat:'聊天请求',models:'模型列表',check:'账户检测'}[kind] || kind);
function logTable(records) {
  if (!records.length) return empty('暂无请求记录','账号检测、模型同步和客户端调用完成后，记录会显示在这里。','logs');
  return `<div class="table-wrap"><table><thead><tr><th>时间</th><th>账户 / 请求</th><th>模型</th><th>首字延迟</th><th>总耗时</th><th>结果</th><th></th></tr></thead><tbody>${records.map(r=>`<tr><td><div class="mono">${time(r.startedAt)}</div><div class="subtle-text">${new Date(r.startedAt).toLocaleDateString('zh-CN')}</div></td><td><div>${esc(r.accountName || '未分配账户')}</div><div class="subtle-text">${kindLabel(r.kind)}${r.stream?' · 流式':''}</div></td><td class="model-name">${esc(r.model || '—')}</td><td class="mono">${duration(r.ttftMs)}</td><td class="mono">${duration(r.durationMs)}</td><td>${badge(r.status,r.error || '')}</td><td><button class="row-detail" data-action="log-detail" data-id="${r.id}">详情</button></td></tr>`).join('')}</tbody></table></div>`;
}
function filteredLogs() {
  const query=logQuery.toLowerCase();
  return state.requests.filter(r=>(`${r.model || ''} ${r.accountName || ''} ${r.error || ''} ${kindLabel(r.kind)}`.toLowerCase().includes(query))&&(logFilter==='all'||r.status===logFilter));
}
function logsContent() {
  const records=filteredLogs(), pages=Math.max(1,Math.ceil(records.length/15));
  logPage=Math.min(logPage,pages-1);
  return `${logTable(records.slice(logPage*15,logPage*15+15))}<div class="table-footer"><span>当前 ${records.length} 条 · 展示最近 200 条</span><div class="pagination"><button data-action="prev-logs" ${!logPage?'disabled':''}>上一页</button><span>${logPage+1} / ${pages}</span><button data-action="next-logs" ${logPage===pages-1?'disabled':''}>下一页</button></div></div>`;
}
function logsPage() {
  return heading('请求日志','从一次请求，追溯账户、模型与响应状态。',`<button class="button secondary" data-action="export-logs">${icon('download')}导出当前结果</button>`,'WORKSPACE / REQUEST LOGS')+
  `<div class="toolbar"><div class="search-box">${icon('search')}<input id="log-search" aria-label="搜索请求日志" placeholder="搜索模型、账户或错误…" value="${esc(logQuery)}"></div><select id="log-filter" aria-label="筛选请求结果">${[['all','全部结果'],['success','成功'],['error','异常'],['cancelled','已取消']].map(([v,l])=>`<option value="${v}" ${v===logFilter?'selected':''}>${l}</option>`).join('')}</select></div><section class="panel table-panel" id="logs-content">${logsContent()}</section><p class="security-caption">仅保存请求元数据，不记录提示词、回答或凭据。数据文件最多保留 2,000 条；指标按保留记录中的近 24 小时计算。</p>`;
}
function connectPage() {
  const base=state.service.baseUrl;
  const model=state.models[0]?.id || 'default';
  const snippet=`curl ${base}/chat/completions \\\n  -H 'Content-Type: application/json' \\\n  -H 'Authorization: Bearer ${state.service.apiKeyRequired?'YOUR_API_KEY':'local'}' \\\n  -d '${JSON.stringify({model,stream:true,messages:[{role:'user',content:'你好，请简单介绍自己。'}]})}'`;
  return heading('连接你的客户端','通过 OpenAI 兼容协议，将客户端接入 Logicc 号池。','','DEVELOPER / API ACCESS')+
  `<div class="integration-grid"><section class="panel integration-panel"><h2>OpenAI 兼容接口</h2><p>在客户端的自定义服务中填写以下 Base URL。</p><div class="copy-field"><code class="mono">${esc(base)}</code><button class="text-button" data-action="copy-url">${icon('copy')}复制</button></div><div class="info-rows"><div><span>API Key</span><b>${state.service.apiKeyRequired?'使用已配置的 API Key':'任意非空字符串，例如 local'}</b></div><div><span>模型列表</span><b class="mono">GET /v1/models</b></div><div><span>聊天补全</span><b class="mono">POST /v1/chat/completions</b></div></div><div class="section-title"><h2>快速测试</h2><span>cURL / Streaming</span></div><div class="code-block"><button class="code-copy" data-action="copy-code">复制</button><pre id="curl-snippet">${esc(snippet)}</pre></div></section><div><section class="panel integration-panel"><h2>自定义 API Key</h2><form id="api-key-form" class="form-panel"><label>新的 API Key<input name="apiKey" type="password" required maxlength="512" autocomplete="new-password" placeholder="输入自定义 Key，或点击生成" spellcheck="false"></label><p class="field-hint">保存后立即生效并持久化，替换原有 Key。服务只保存摘要，不返回明文；请先复制保管。</p><div class="heading-actions"><button type="button" class="button secondary" data-action="generate-api-key">生成</button><button type="button" class="button secondary" data-action="copy-api-key">复制</button><button type="submit" class="button primary">保存</button></div></form></section><section class="panel integration-panel section-gap"><h2>连接信息</h2><div class="info-rows"><div><span>服务范围</span><b>通过服务器 IP / 域名访问</b></div><div><span>上游服务</span><b>app.logicc.com</b></div><div><span>账户调度</span><b>低并发优先轮询</b></div><div><span>速率限制</span><b>429 后冷却 60 秒</b></div><div><span>凭据异常</span><b>401 / 403 后冷却 5 分钟</b></div><div><span>请求记录</span><b>最多 2,000 条</b></div></div></section><div class="notice"><strong>关于凭据刷新</strong><br>__client Cookie + Session ID 可按需获取短期 JWT。客户端凭据失效时，在号池中更新后重新检测即可。<br><br>检测和实际请求会更新账户状态；控制台自动刷新只读取本地数据。</div></div></div>`;
}
function playgroundPage() {
  return heading('发起一次真实请求','直接验证号池、模型与流式响应；测试会消耗上游额度。','','WORKSPACE / PLAYGROUND')+
  `<div class="playground-grid"><form class="panel form-panel" id="play-form"><label>模型<select name="model" required>${state.models.length?state.models.map(m=>`<option value="${esc(m.id)}">${esc(m.id)}</option>`).join(''):'<option value="default">default · 上游默认模型</option>'}</select></label><label>提示词<textarea name="prompt" required placeholder="输入你想发送给模型的消息…">用一句话介绍你自己。</textarea></label>${state.service.apiKeyRequired?'<label>代理 API Key<input type="password" name="apiKey" required autocomplete="off" placeholder="本次请求使用，不保存"></label>':''}<label>内置工具<select name="tool"><option value="">不指定</option><option value="web_search">网页搜索</option><option value="image_generation">图片生成（仅透传）</option></select></label><div class="heading-actions"><button type="submit" class="button primary" id="play-submit">${icon('play')}发送请求</button><button type="button" class="button secondary" data-action="stop-play" id="play-stop" hidden>停止</button></div><p class="field-hint">账户由调度池分配，结果会记录到请求日志。图片工具返回内容以文本形式展示。</p></form><section class="panel output-panel"><div class="panel-heading"><div><h2>模型响应</h2><p>STREAMING RESPONSE</p></div><span class="range-label" id="play-status">等待发送</span></div><pre id="play-output" class="output-placeholder" aria-live="polite">在左侧输入消息，查看实时响应。</pre><div class="output-meta" id="play-meta">连接本地 OpenAI 兼容接口</div></section></div>`;
}
function openAccount(id) {
  const form=$('#account-form'); form.reset();
  errorAt('#account-error','');
  const account=id?state.accounts.find(a=>a.id===id):null;
  form.elements.id.value=id || '';
  form.elements.name.value=account?.name || '';
  form.elements.sessionId.value=account?.sessionId || '';
  form.elements.enabled.checked=account?account.enabled:true;
  form.elements.clientCookie.placeholder=account?.hasClientCookie?'已保存 · 留空保留原凭据':'粘贴 clerk.logicc.com 的 __client 值';
  form.querySelector('details').open=false;
  $('#account-dialog-title').textContent=account?'编辑账户':'添加账户';
  $('#account-dialog').showModal();
  form.elements.name.focus();
}
async function checkAccount(id, refresh=false, silent=false) {
  busyAccounts.add(id);busyCount++;
  try {
    const result=await api(`/accounts/${id}/${refresh?'refresh':'check'}`,{method:'POST'});
    if(!silent)toast(`账户可用 · 已同步 ${result.models} 个模型`);
    return true;
  } catch(error) { if(!silent)toast(error.message,true); return false; }
  finally { busyAccounts.delete(id);busyCount--; }
}
async function copy(text) { try { await navigator.clipboard.writeText(text);toast('已复制到剪贴板'); } catch {toast('复制失败，请手动选择文本复制',true);} }

$('#account-form').addEventListener('submit',async event=>{
  event.preventDefault(); const form=event.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;errorAt('#account-error','');
  const values=Object.fromEntries(new FormData(form)); const id=values.id;delete values.id;values.enabled=form.elements.enabled.checked;
  if (!values.token.trim()) delete values.token;
  if (!values.clientCookie.trim()) delete values.clientCookie;
  try {await api(id?`/accounts/${id}`:'/accounts',{method:id?'PATCH':'POST',body:values});form.reset();$('#account-dialog').close();toast(id?'账户已更新':'账户已添加，可以检测连接');await reload(true);}
  catch(error){errorAt('#account-error',error.message);}finally{button.disabled=false;}
});
$('#import-file').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  if(file.size>1048576){errorAt('#import-error','文件不能超过 1 MB');return;}
  $('#import-form').elements.accounts.value=await file.text();
});
$('#import-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;errorAt('#import-error','');
  try {let body;try{body=JSON.parse(form.elements.accounts.value);}catch{throw new Error('JSON 格式不正确，请检查引号和逗号');}const result=await api('/accounts/import',{method:'POST',body});form.reset();$('#import-dialog').close();toast(`成功导入 ${result.accounts.length} 个账户`);await reload(true);}
  catch(error){errorAt('#import-error',error.message);}finally{button.disabled=false;}
});
$('#confirm-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.currentTarget.querySelector('[type=submit]');button.disabled=true;errorAt('#confirm-error','');
  try{await api(`/accounts/${deleteId}`,{method:'DELETE'});$('#confirm-dialog').close();toast('账户已移除');await reload(true);}catch(error){errorAt('#confirm-error',error.message);}finally{button.disabled=false;}
});
document.addEventListener('input',event=>{
  if(event.target.id==='account-search'){accountQuery=event.target.value;$('#accounts-table').innerHTML=filteredAccounts();}
  if(event.target.id==='log-search'){logQuery=event.target.value;logPage=0;$('#logs-content').innerHTML=logsContent();}
});
document.addEventListener('change',event=>{
  if(event.target.id==='account-filter'){accountFilter=event.target.value;$('#accounts-table').innerHTML=filteredAccounts();}
  if(event.target.id==='log-filter'){logFilter=event.target.value;logPage=0;$('#logs-content').innerHTML=logsContent();}
});
document.addEventListener('click',async event=>{
  if (locked) return;
  const close=event.target.closest('[data-close]');if(close){$(`#${close.dataset.close}`).close();return;}
  const button=event.target.closest('[data-action]');if(!button || button.disabled)return;
  const {action,id}=button.dataset;
  button.closest('details')?.removeAttribute('open');
  try {
    if(action==='add')return openAccount();
    if(action==='edit')return openAccount(id);
    if(action==='import'){errorAt('#import-error','');$('#import-form').reset();return $('#import-dialog').showModal();}
    if(action==='delete'){deleteId=id;errorAt('#confirm-error','');$('#confirm-message').textContent=`将移除「${state.accounts.find(a=>a.id===id).name}」及其本地凭据。已有请求记录会保留。`;return $('#confirm-dialog').showModal();}
    if(action==='log-detail'){
      const r=state.requests.find(r=>r.id===id);
      $('#request-detail').innerHTML=`<dl class="details-list">${[['请求 ID',r.id],['开始时间',date(r.startedAt)],['请求类型',kindLabel(r.kind)],['账户',r.accountName || '未分配'],['模型',r.model || '—'],['首字延迟',duration(r.ttftMs)],['总耗时',duration(r.durationMs)],['结果',statuses[r.status]],['Token 用量',r.usage?`${r.usage.prompt_tokens} 输入 / ${r.usage.completion_tokens} 输出`:'上游未提供'],...(r.error?[['错误',r.error]]:[])].map(([label,value])=>`<div><dt>${label}</dt><dd class="${label==='错误'?'error-detail':''}">${esc(value)}</dd></div>`).join('')}</dl>`;return $('#detail-dialog').showModal();
    }
    if(action==='copy-url')return copy(state.service.baseUrl);
    if(action==='generate-api-key') {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      $('#api-key-form').elements.apiKey.value = `sk-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
      toast('已生成，请复制保存后点击保存'); return;
    }
    if(action==='copy-api-key')return copy($('#api-key-form').elements.apiKey.value);
    if(action==='copy-code')return copy($('#curl-snippet').textContent);
    if(action==='prev-logs'||action==='next-logs'){logPage+=action==='next-logs'?1:-1;$('#logs-content').innerHTML=logsContent();return;}
    if(action==='export-logs'){
      const cell=value=>`"${String(value??'').replace(/^[=+@-]/,"'").replace(/"/g,'""')}"`;
      const csv=[['时间','类型','账户','模型','结果','首字延迟(ms)','耗时(ms)','错误'],...filteredLogs().map(r=>[date(r.startedAt),kindLabel(r.kind),r.accountName,r.model,statuses[r.status],r.ttftMs,r.durationMs,r.error])].map(row=>row.map(cell).join(',')).join('\r\n');
      const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`logicc-requests-${new Date().toISOString().slice(0,10)}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
    }
    if(action==='try-model'){location.hash='playground';page='playground';render();$('#play-form').elements.model.value=button.dataset.model;return;}
    if(action==='stop-play'){playController?.abort();return;}
    button.disabled=true;busyCount++;
    if(action==='check'||action==='refresh-token')await checkAccount(id,action==='refresh-token');
    if(action==='toggle'){const a=state.accounts.find(a=>a.id===id);await api(`/accounts/${id}`,{method:'PATCH',body:{enabled:!a.enabled}});toast(a.enabled?'已暂停此账户调度':'账户已启用');}
    if(action==='sync-models'){const result=await api('/models/refresh',{method:'POST'});toast(`已同步 ${result.models.length} 个模型`);}
    if(action==='check-all'){
      const accounts=state.accounts.filter(a=>a.enabled);let ok=0;
      if(!accounts.length)toast('没有已启用的账户');
      else{for(let i=0;i<accounts.length;i++){button.textContent=`检测 ${i+1} / ${accounts.length}`;if(await checkAccount(accounts[i].id,false,true))ok++;}toast(`检测完成：${ok} 个可用，${accounts.length-ok} 个异常`,ok!==accounts.length);}
    }
    await reload(true);
  }catch(error){toast(error.message,true);}
  finally{if(button.disabled){button.disabled=false;busyCount=Math.max(0,busyCount-1);}}
});
document.addEventListener('submit',async event=>{
  if(event.target.id==='api-key-form') {
    event.preventDefault();
    const form = event.target, button = form.querySelector('[type=submit]');
    button.disabled = true; busyCount++;
    try {
      await api('/settings/api-key', { method: 'PUT', body: { apiKey: form.elements.apiKey.value } });
      form.reset(); toast('API Key 已保存并立即生效，请使用新 Key 调用接口');
    } catch(error) { toast(error.message, true); }
    finally { button.disabled = false; busyCount--; await reload(true); }
    return;
  }
  if(event.target.id!=='play-form')return;
  event.preventDefault();if(playController)return;
  const form=event.target,output=$('#play-output'),status=$('#play-status'),meta=$('#play-meta'),submit=$('#play-submit'),stop=$('#play-stop');
  playController=new AbortController();playStarted=performance.now();let first=null;
  submit.disabled=true;stop.hidden=false;output.textContent='';output.classList.remove('output-placeholder');status.textContent='请求中';meta.textContent='正在等待模型响应…';
  const data=new FormData(form),body={model:data.get('model'),stream:true,messages:[{role:'user',content:data.get('prompt')}]};
  if(data.get('tool'))body.tools=[{type:'function',function:{name:data.get('tool')}}];
  try{
    const response=await fetch('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${data.get('apiKey')||'local'}`},body:JSON.stringify(body),signal:playController.signal});
    if(!response.ok){const result=await response.json();throw new Error(result.error?.message||`HTTP ${response.status}`);}
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    for(;;){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let index;
      while((index=buffer.indexOf('\n\n'))!==-1){const frame=buffer.slice(0,index);buffer=buffer.slice(index+2);for(const line of frame.split('\n')){if(!line.startsWith('data:'))continue;const text=line.slice(5).trim();if(!text||text==='[DONE]')continue;const chunk=JSON.parse(text);if(chunk.error)throw new Error(chunk.error.message);const delta=chunk.choices?.[0]?.delta?.content;if(delta){first??=performance.now()-playStarted;output.textContent+=delta;status.textContent='接收中';}}}
    }
    status.textContent='已完成';meta.textContent=`首段文本 ${duration(first)} · 总耗时 ${duration(performance.now()-playStarted)}`;
    if(!output.textContent)output.textContent='请求已完成，但上游未返回文本。';
  }catch(error){const cancelled=error.name==='AbortError';status.textContent=cancelled?'已停止':'请求失败';meta.textContent=cancelled?'请求已由你停止':error.message;if(!output.textContent)output.textContent=cancelled?'请求已停止。':error.message;}
  finally{playController=null;submit.disabled=false;stop.hidden=true;await reload();}
});
window.addEventListener('hashchange',()=>{if(playController)playController.abort();page=location.hash.slice(1)||'overview';render();$('#main').focus({preventScroll:true});window.scrollTo(0,0);});
$('#refresh').addEventListener('click',()=>reload(true));
for(const dialog of document.querySelectorAll('dialog:not(#login-dialog)'))dialog.addEventListener('click',event=>{if(event.target===dialog){const box=dialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)dialog.close();}});
await reload(true);
setInterval(()=>{if(!document.hidden)reload();},5000);

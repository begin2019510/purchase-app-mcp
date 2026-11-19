'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin/purchase-app-mcp.js');
const { createRequire } = require('module');
const req = createRequire(path.join(ROOT, 'package.json'));
const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = req('@modelcontextprotocol/sdk/client/stdio.js');

const HOME1 = fs.mkdtempSync(path.join(os.tmpdir(), 'pamcp-home1-'));
const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pamcp-home2-'));

function assert(c, m) {
  if (!c) { console.error('\n❌ FAIL: ' + m); process.exitCode = 1; throw new Error(m); }
  console.log('✓ ' + m);
}
function text(r) { return (r && r.content && r.content[0] && r.content[0].text) || ''; }
function runCli(args, env) {
  try {
    return execFileSync(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    console.error('CLI failed:', args.join(' '));
    console.error('stdout:', e.stdout);
    console.error('stderr:', e.stderr);
    throw e;
  }
}

(async () => {
  const mock = spawn(process.execPath, [path.join(__dirname, 'mock-api.js')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('mock start timeout')), 5000);
    mock.stdout.on('data', d => {
      buf += d;
      const m = /\{"port":(\d+)\}/.exec(buf);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
  });
  const base = 'http://127.0.0.1:' + port;
  console.log('mock api:', base, '\n');

  const env1 = { PURCHASE_APP_BASE_URL: base, PURCHASE_APP_MCP_HOME: HOME1 };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: { ...process.env, ...env1 },
  });
  const client = new Client({ name: 'e2e-client', version: '1.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map(t => t.name);
  assert(names.length === 35, 'tools/list 共 35 个工具（v1.4.0 含写工具），实际 ' + names.length);
  assert(
    ['purchase.list', 'phase.status.set', 'analytics.summary',
      'supplier.add', 'supplier.update', 'supplier.delete',
      'purchase.decide', 'purchase.undecided', 'purchase.cancel',
      'order.transition', 'order.update'].every(n => names.includes(n)),
    'tools/list 注册完整（含 v1.4.0 写/授权工具）'
  );
  assert(!names.some(n => /user|deploy|shell|log/i.test(n)), '不含用户管理/部署/shell 类工具');

  const r0 = await client.callTool({ name: 'purchase.list', arguments: {} });
  assert(r0.isError && /尚未登录/.test(text(r0)), '未登录时工具返回可操作的中文提示');

  const loginOut = runCli(['login'], { ...env1, PURCHASE_APP_USERNAME: 'admin', PURCHASE_APP_PASSWORD: 'testpass' });
  assert(/登录成功/.test(loginOut), 'CLI 登录成功');

  const authFile = path.join(HOME1, 'auth.json');
  const st = fs.statSync(authFile);
  assert((st.mode & 0o777) === 0o600, 'auth.json 权限为 0600');
  assert((fs.statSync(HOME1).mode & 0o777) === 0o700, '凭据目录权限为 0700');
  const saved = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  assert(saved.refreshToken && !JSON.stringify(saved).includes('testpass'), '只保存 refresh token，不含密码');
  assert(saved.username === 'admin' && saved.baseUrl === base, '凭据绑定账号与 App 地址');

  const r1 = await client.callTool({ name: 'purchase.list', arguments: {} });
  assert(!r1.isError, '同一 MCP 进程在 CLI 登录后可直接使用');
  const list = JSON.parse(text(r1));
  assert(list.items.length === 3 && list.items[0].name === '测试商品' && list.items[0].price === 99 && list.items[0].qty === 2, '读接口中文字段映射正确');
  assert(list.source === 'needs', 'purchase.list 优先读 /api/needs');
  assert(list.items[0].needStatus === '已定点' && list.items[0].legacyStatus === '已下单' && list.items[0].orderStatus === '已下单', 'need 状态与兼容状态分离');
  assert(Array.isArray(list.items[0].orders) && list.items[0].orders.length === 1 && Array.isArray(list.items[0].suppliers), '返回完整 orders/suppliers');
  // 全量列表统一最新在前：无子单需求靠创建时间兜底排序
  assert(list.items[1].name === '近期对比中' && list.items[2].name === '九月旧需求', '列表按日期倒序（createdAt 兜底）');
  const rStatusNeed = await client.callTool({ name: 'purchase.list', arguments: { status: '已定点' } });
  assert(!rStatusNeed.isError && JSON.parse(text(rStatusNeed)).items.length === 1, '按需求状态筛选');
  const rStatusOrder = await client.callTool({ name: 'purchase.list', arguments: { status: '已下单' } });
  assert(!rStatusOrder.isError && JSON.parse(text(rStatusOrder)).items.length === 1, '按子单状态筛选（兼容旧词表）');
  // limit 语义：先倒序再截取，恒为最新 N 条（旧逻辑 slice(-N) 在 needs 新→旧下会截成最旧）
  const rLimit = await client.callTool({ name: 'purchase.list', arguments: { limit: 2 } });
  const limitList = JSON.parse(text(rLimit));
  assert(limitList.items.length === 2
    && limitList.items[0].id === 'rec_mock_1'
    && limitList.items[1].name === '近期对比中',
    'purchase limit=2 返回最新 2 条（不被服务端新→旧截反）');

  let state = await (await fetch(base + '/__state')).json();
  const beforeInvalidate = state.refreshCount;
  await fetch(base + '/__invalidate_access', { method: 'POST' });
  const r2 = await client.callTool({ name: 'purchase.list', arguments: {} });
  assert(!r2.isError, 'access token 失效后自动 refresh + 重试成功');
  state = await (await fetch(base + '/__state')).json();
  assert(state.refreshCount === beforeInvalidate + 1, 'access 失效后恰好发生一次 refresh 轮换');
  const saved2 = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  assert(saved2.refreshToken !== saved.refreshToken, '轮换后的 refresh token 已原子落盘');

  const rb = await client.callTool({ name: 'budget.get', arguments: {} });
  assert(!rb.isError && JSON.parse(text(rb)).data['2026-10'].total === 1000, '预算读取正常');

  const rt = await client.callTool({ name: 'todo.list', arguments: {} });
  assert(!rt.isError, '待办读取正常');

  // 记账：服务端旧→新，MCP 统一倒序；limit 同样取最新
  const rExp = await client.callTool({ name: 'expense.list', arguments: {} });
  const expAll = JSON.parse(text(rExp));
  assert(expAll.items.length === 3
    && expAll.items[0].date === '2026-11-01'
    && expAll.items[1].date === '2026-10-15'
    && expAll.items[2].date === '2026-10-05',
    'expense.list 统一按日期倒序（最新在前）');
  const rExp2 = await client.callTool({ name: 'expense.list', arguments: { limit: 2 } });
  const exp2 = JSON.parse(text(rExp2));
  assert(exp2.items.length === 2
    && exp2.items[0].date === '2026-11-01'
    && exp2.items[1].date === '2026-10-15',
    'expense limit=2 返回最新 2 条');

  const ra = await client.callTool({ name: 'analytics.summary', arguments: { month: '2026-10' } });
  assert(!ra.isError && JSON.parse(text(ra)).month === '2026-10', '月度统计聚合正常');
  assert(JSON.parse(text(ra)).source === 'needs', '统计优先从 needs 子单聚合');

  const rp = await client.callTool({ name: 'phase.status.set', arguments: { projectId: 'p1', phaseIdx: 0, status: 'done' } });
  assert(rp.isError && /网页|JSON/.test(text(rp)), '缺失的公网阶段端点返回明确错误（不误报成功）');

  assert(!text(r1).includes('testpass'), '工具响应不含密码');

  const audit = fs.readFileSync(path.join(HOME1, 'audit.log'), 'utf8');
  assert(/"event":"tool_call"/.test(audit) && /"tool":"purchase.list"/.test(audit), '本机审计日志记录工具调用');
  assert(!audit.includes('testpass'), '审计日志不含密码');
  assert((fs.statSync(path.join(HOME1, 'audit.log')).mode & 0o777) === 0o600, '审计日志权限为 0600');

  await client.close();

  // ---- 网页登录（错误密码重试 → 正确密码成功）----
  const env2 = { PURCHASE_APP_BASE_URL: base, PURCHASE_APP_MCP_HOME: HOME2 };
  const child = spawn(process.execPath, [BIN, 'login'], { env: { ...process.env, ...env2 }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errBuf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { errBuf += d; });
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('login page timeout\n' + errBuf)), 8000);
    child.stderr.on('data', () => {
      const m = /http:\/\/127\.0\.0\.1:\d+\/login\/[A-Za-z0-9_-]+/.exec(errBuf);
      if (m) { clearTimeout(t); resolve(m[0]); }
    });
  });
  assert(/^http:\/\/127\.0\.0\.1/.test(url), '登录页仅监听 127.0.0.1 并打印一次性地址');

  const wrong = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'wrong' }),
  });
  assert(wrong.status === 401 && /用户名或密码错误/.test(await wrong.text()), '错误密码在页面显示错误、不写凭据');

  const good = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'testpass' }),
  });
  assert(good.status === 200 && /登录成功/.test(await good.text()), '网页登录成功');

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('login process did not exit')), 5000);
    child.on('exit', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error('login exit ' + code)); });
  });
  assert(fs.existsSync(path.join(HOME2, 'auth.json')), '网页登录写入本机凭据');

  const statusOut = runCli(['status'], env2);
  assert(/登录状态:\s*已登录/.test(statusOut) && /admin/.test(statusOut), 'status 命令显示已登录');

  const logoutOut = runCli(['logout'], env2);
  assert(/已退出登录/.test(logoutOut) && !fs.existsSync(path.join(HOME2, 'auth.json')), 'logout 删除本机凭据');
  state = await (await fetch(base + '/__state')).json();
  assert(state.logoutCount >= 1, 'logout 调用服务端吊销 refresh token');

  const statusOut2 = runCli(['status'], env2);
  assert(/登录状态:\s*未登录/.test(statusOut2), 'status 命令显示未登录');

  // ---- 一次性安装链接：link → install → 独立凭据 ----
  const HOME3 = fs.mkdtempSync(path.join(os.tmpdir(), 'pamcp-home3-'));
  const cfgFile = path.join(HOME3, 'mcp-config.json');
  const skillDir = path.join(HOME3, 'skills', 'purchase-app');
  const env3 = { PURCHASE_APP_BASE_URL: base, PURCHASE_APP_MCP_HOME: HOME3 };

  const linkOut = runCli(['link'], env1);
  const linkDoc = JSON.parse(linkOut);
  assert(linkDoc.ok && /\/agent(?:\.html)?#t=[A-Za-z0-9_-]{20,}/.test(linkDoc.url), 'link 生成 /agent#t=… 一次性安装链接');
  assert(/^npx -y github:begin2019510\/purchase-app-mcp install /.test(linkDoc.command), 'link 返回可直接交给 agent 的执行命令');
  const ticket = /#t=([A-Za-z0-9_-]+)/.exec(linkDoc.url)[1];
  const home1Token = JSON.parse(fs.readFileSync(authFile, 'utf8')).refreshToken;

  const installOut = runCli([
    'install', linkDoc.url,
    '--home', HOME3,
    '--agent', 'json',
    '--config', cfgFile,
    '--skill-dir', skillDir,
    '--local',
  ], env3);
  assert(/INSTALL_OK username=admin/.test(installOut), 'install 用链接完成注册、授权与只读验证');
  assert(/只读验证通过（采购记录 3 条，source=needs）/.test(installOut), 'install 结束后执行只读验证（needs）');
  assert(fs.existsSync(skillDir + '/SKILL.md') && fs.existsSync(cfgFile), 'install 同时安装 skill 并写入 MCP 配置');

  const auth3 = path.join(HOME3, 'auth.json');
  assert(fs.existsSync(auth3), 'install 写入本机凭据');
  assert((fs.statSync(auth3).mode & 0o777) === 0o600, 'install 凭据权限为 0600');
  const saved3 = JSON.parse(fs.readFileSync(auth3, 'utf8'));
  assert(saved3.refreshToken !== home1Token, 'install 使用独立 refresh token（不影响原会话）');
  assert(saved3.source === 'install-link', '凭据标记来源为 install-link');
  assert(!JSON.stringify(saved3).includes(ticket), '安装票据不写入凭据文件');

  const transport3 = new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...process.env, ...env3 } });
  const client3 = new Client({ name: 'e2e-client-3', version: '1.0.0' });
  await client3.connect(transport3);
  const r3 = await client3.callTool({ name: 'purchase.list', arguments: {} });
  assert(!r3.isError && JSON.parse(text(r3)).items.length === 3, '新安装实例可立即只读访问');
  await client3.close();

  // 主会话凭据未被安装流程影响
  const r1b = await (async () => {
    const c = new Client({ name: 'e2e-client-1b', version: '1.0.0' });
    const t = new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...process.env, ...env1 } });
    await c.connect(t);
    const r = await c.callTool({ name: 'purchase.list', arguments: {} });
    await c.close();
    return r;
  })();
  assert(!r1b.isError, '原账号凭据在 install 之后仍可用');

  // --home 必须覆盖环境变量：status/logout 也要作用在指定目录
  const statusHome = runCli(['status', '--home', HOME3], env1);
  assert(/登录状态:\s*已登录/.test(statusHome) && statusHome.includes(auth3), 'status --home 读取指定目录');
  const logoutHome = runCli(['logout', '--home', HOME3], env1);
  assert(/已退出登录/.test(logoutHome) && !fs.existsSync(auth3), 'logout --home 删除指定目录的凭据');
  assert(fs.existsSync(authFile), 'logout --home 不影响环境变量里的其他安装');

  let reuseErr = null;
  try {
    runCli(['install', linkDoc.url, '--home', HOME3, '--agent', 'json', '--config', cfgFile, '--skill-dir', skillDir, '--local'], env3);
  } catch (e) {
    reuseErr = e;
  }
  assert(reuseErr && /无效、已过期或已被使用/.test(reuseErr.stderr || ''), '同一安装链接不能重复使用');

  let badErr = null;
  try {
    runCli(['install', 'https://example.com/agent#t=short', '--home', HOME3], env3);
  } catch (e) {
    badErr = e;
  }
  assert(badErr && /无法从链接中识别安装票据/.test(badErr.stderr || ''), '无效链接被拒绝且不发起兑换');

  // ---- v1.4.0 写路径 + T1 二次授权（在只读/安装断言之后，避免改动夹具计数）----
  // 主 client 已在登录段关闭，这里用 env1 重新连一个
  const clientW = new Client({ name: 'e2e-client-write', version: '1.0.0' });
  await clientW.connect(new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: { ...process.env, ...env1 },
  }));

  const rCmp = await clientW.callTool({
    name: 'purchase.create',
    arguments: { name: '对比新需求', category: '数码', compareOnly: true, budgetMin: 10, budgetMax: 20 },
  });
  assert(!rCmp.isError && JSON.parse(text(rCmp)).id, 'compareOnly 走 /api/needs 创建需求');
  const listW = JSON.parse(text(await clientW.callTool({ name: 'purchase.list', arguments: {} })));
  const newNeed = listW.items.find(i => i.name === '对比新需求');
  assert(newNeed && newNeed.needStatus === '对比中', '新建需求状态为对比中且出现在列表');

  const rSupAdd = await clientW.callTool({
    name: 'supplier.add',
    arguments: {
      needId: newNeed.id, name: '供应商A', price: 50, platform: '淘宝',
      pros: '便宜', cons: '发货慢',
    },
  });
  assert(!rSupAdd.isError && JSON.parse(text(rSupAdd)).id, 'supplier.add 添加供应商');
  const supId = JSON.parse(text(rSupAdd)).id;

  const rSupUp = await clientW.callTool({
    name: 'supplier.update',
    arguments: { id: supId, pros: '价格低、包邮', cons: '售后一般', note: '备选主力' },
  });
  assert(!rSupUp.isError, 'supplier.update 更新优缺点（T0 代写）');
  const gotNeed = JSON.parse(text(await clientW.callTool({ name: 'purchase.get', arguments: { id: newNeed.id } })));
  const gotSup = (gotNeed.suppliers || []).find(s => s.id === supId);
  assert(gotSup && gotSup.pros === '价格低、包邮' && gotSup.cons === '售后一般', '优缺点已写入供应商');

  // 综合推荐（T0）：写结论 + 指定推荐供应商，回读一致
  const rRec = await clientW.callTool({
    name: 'purchase.update',
    arguments: {
      id: newNeed.id,
      recommendation: '推荐供应商A：¥50 档包邮且差评未见，比 B 便宜 ¥10',
      recommendSupplierId: supId,
    },
  });
  assert(!rRec.isError, 'purchase.update 写综合推荐（T0）');
  const gotRec = JSON.parse(text(await clientW.callTool({ name: 'purchase.get', arguments: { id: newNeed.id } })));
  assert(gotRec.recommendation && gotRec.recommendation.indexOf('推荐供应商A') >= 0, '综合推荐文本已回读');
  assert(gotRec.recommendSupplierId === supId, '推荐供应商 ID 已回读');

  const rDec = await clientW.callTool({
    name: 'purchase.decide',
    arguments: { needId: newNeed.id, supplierId: supId },
  });
  assert(!rDec.isError, 'purchase.decide 定点（T0）');
  const afterDec = JSON.parse(text(await clientW.callTool({ name: 'purchase.get', arguments: { id: newNeed.id } })));
  assert(afterDec.needStatus === '已定点', '定点后需求状态为已定点');

  const rTrFwd = await clientW.callTool({ name: 'order.transition', arguments: { id: 'rec_o1', to: '已到' } });
  assert(!rTrFwd.isError, 'order.transition 正向已下单→已到（T0）');

  const rTrTermBad = await clientW.callTool({ name: 'order.transition', arguments: { id: 'rec_o1', to: '已退' } });
  assert(rTrTermBad.isError && /二次授权|confirm/.test(text(rTrTermBad)), '终态流转缺 confirm 被拒绝');
  const rTrTermOk = await clientW.callTool({
    name: 'order.transition',
    arguments: { id: 'rec_o1', to: '已退', confirm: '测试商品' },
  });
  assert(!rTrTermOk.isError, '终态流转 confirm=父需求名后执行');

  const rOrUp = await clientW.callTool({
    name: 'order.update',
    arguments: { id: 'rec_o1', note: '已退货入库' },
  });
  assert(!rOrUp.isError, 'order.update 更新备注（T0）');

  // purchase.delete：缺 confirm / 错 confirm / 正确 confirm
  const rDelBad = await clientW.callTool({ name: 'purchase.delete', arguments: { id: newNeed.id } });
  assert(rDelBad.isError && /二次授权/.test(text(rDelBad)), 'purchase.delete 缺 confirm 被拒绝');
  const rDelMis = await clientW.callTool({
    name: 'purchase.delete',
    arguments: { id: newNeed.id, confirm: '错名字' },
  });
  assert(rDelMis.isError && /confirm 不匹配/.test(text(rDelMis)), 'purchase.delete confirm 不匹配被拒绝');
  const rDelOk = await clientW.callTool({
    name: 'purchase.delete',
    arguments: { id: newNeed.id, confirm: '对比新需求' },
  });
  assert(!rDelOk.isError, 'purchase.delete confirm 匹配后删除');

  // supplier.delete T1
  const rSupAdd2 = await clientW.callTool({
    name: 'supplier.add',
    arguments: { needId: 'rec_mock_0', name: '临时供应商', pros: 'x' },
  });
  const sup2 = JSON.parse(text(rSupAdd2)).id;
  const rSupDelMis = await clientW.callTool({ name: 'supplier.delete', arguments: { id: sup2, confirm: 'nope' } });
  assert(rSupDelMis.isError && /confirm 不匹配/.test(text(rSupDelMis)), 'supplier.delete confirm 不匹配被拒绝');
  const rSupDelOk = await clientW.callTool({ name: 'supplier.delete', arguments: { id: sup2, confirm: '临时供应商' } });
  assert(!rSupDelOk.isError, 'supplier.delete confirm 匹配后删除');

  // purchase.cancel T1（rec_mock_0 无入账子单，可取消）
  const rCanMis = await clientW.callTool({ name: 'purchase.cancel', arguments: { id: 'rec_mock_0', confirm: 'x' } });
  assert(rCanMis.isError && /confirm 不匹配/.test(text(rCanMis)), 'purchase.cancel confirm 不匹配被拒绝');
  const rCanOk = await clientW.callTool({
    name: 'purchase.cancel',
    arguments: { id: 'rec_mock_0', reason: '不买了', confirm: '九月旧需求' },
  });
  assert(!rCanOk.isError, 'purchase.cancel confirm 匹配后取消');

  // purchase.undecided：先给 rec_mock_2 定点再回退
  const rSup3 = await clientW.callTool({
    name: 'supplier.add',
    arguments: { needId: 'rec_mock_2', name: '定点候选', price: 30 },
  });
  const sup3 = JSON.parse(text(rSup3)).id;
  await clientW.callTool({ name: 'purchase.decide', arguments: { needId: 'rec_mock_2', supplierId: sup3 } });
  const rUndMis = await clientW.callTool({ name: 'purchase.undecided', arguments: { id: 'rec_mock_2', confirm: 'x' } });
  assert(rUndMis.isError && /confirm 不匹配/.test(text(rUndMis)), 'purchase.undecided confirm 不匹配被拒绝');
  const rUndOk = await clientW.callTool({
    name: 'purchase.undecided',
    arguments: { id: 'rec_mock_2', confirm: '近期对比中' },
  });
  assert(!rUndOk.isError, 'purchase.undecided confirm 匹配后回退');

  // expense.delete T1：备注「新」
  const rExpDelMis = await clientW.callTool({ name: 'expense.delete', arguments: { id: 'rec_e3', confirm: 'x' } });
  assert(rExpDelMis.isError && /confirm 不匹配/.test(text(rExpDelMis)), 'expense.delete confirm 不匹配被拒绝');
  const rExpDelOk = await clientW.callTool({ name: 'expense.delete', arguments: { id: 'rec_e3', confirm: '新' } });
  assert(!rExpDelOk.isError, 'expense.delete confirm=备注后删除');

  // project.delete T1：项目名「测试项目」
  const rProjMis = await clientW.callTool({ name: 'project.delete', arguments: { id: 'p1', confirm: 'x' } });
  assert(rProjMis.isError && /confirm 不匹配/.test(text(rProjMis)), 'project.delete confirm 不匹配被拒绝');
  const rProjOk = await clientW.callTool({ name: 'project.delete', arguments: { id: 'p1', confirm: '测试项目' } });
  assert(!rProjOk.isError, 'project.delete confirm 匹配后删除');

  // todo.delete purge T1；软删仍 T0
  const rTodoSoft = await clientW.callTool({ name: 'todo.delete', arguments: { id: 'rec_t1' } });
  assert(!rTodoSoft.isError, 'todo 软删无需 confirm（T0）');
  await clientW.callTool({ name: 'todo.create', arguments: { title: '硬删目标' } });
  // mock POST 会 push；再取最新 id
  const todosNow = JSON.parse(text(await clientW.callTool({ name: 'todo.list', arguments: {} })));
  const hardTodo = todosNow.items.find(t => t.title === '硬删目标');
  assert(hardTodo, 'todo.create 创建硬删目标');
  const rPurgeMis = await clientW.callTool({ name: 'todo.delete', arguments: { id: hardTodo.id, purge: true, confirm: 'x' } });
  assert(rPurgeMis.isError && /confirm 不匹配/.test(text(rPurgeMis)), 'todo purge confirm 不匹配被拒绝');
  const rPurgeOk = await clientW.callTool({
    name: 'todo.delete',
    arguments: { id: hardTodo.id, purge: true, confirm: '硬删目标' },
  });
  assert(!rPurgeOk.isError, 'todo purge confirm 匹配后彻底删除');

  // cats/recurring update：固定字面量
  const rCatsMis = await clientW.callTool({ name: 'cats.update', arguments: { patch: { list: ['A'] } } });
  assert(rCatsMis.isError && /覆盖确认/.test(text(rCatsMis)), 'cats.update 缺 confirm 提示固定字面量');
  const rCatsOk = await clientW.callTool({
    name: 'cats.update',
    arguments: { patch: { list: ['A'] }, confirm: '覆盖确认' },
  });
  assert(!rCatsOk.isError, 'cats.update confirm=覆盖确认后执行');
  const rRecMis = await clientW.callTool({ name: 'recurring.update', arguments: { patch: { items: [] }, confirm: '别的' } });
  assert(rRecMis.isError && /confirm 不匹配/.test(text(rRecMis)), 'recurring.update confirm 不匹配被拒绝');
  const rRecOk = await clientW.callTool({
    name: 'recurring.update',
    arguments: { patch: { items: [] }, confirm: '覆盖确认' },
  });
  assert(!rRecOk.isError, 'recurring.update confirm 匹配后执行');

  await clientW.close();
  mock.kill('SIGTERM');
  fs.rmSync(HOME1, { recursive: true, force: true });
  fs.rmSync(HOME2, { recursive: true, force: true });
  fs.rmSync(HOME3, { recursive: true, force: true });
  console.log('\n✅ 全部端到端测试通过\n');
  process.exit(0);
})().catch(e => {
  console.error('\n' + (e && e.stack ? e.stack : e));
  process.exit(1);
});

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
  assert(names.includes('purchase.list') && names.includes('phase.status.set') && names.includes('analytics.summary'), 'tools/list 注册完整（' + names.length + ' 个工具）');
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
  assert(list.items.length === 1 && list.items[0].name === '测试商品' && list.items[0].price === 99 && list.items[0].qty === 2, '读接口中文字段映射正确');

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

  const ra = await client.callTool({ name: 'analytics.summary', arguments: { month: '2026-10' } });
  assert(!ra.isError && JSON.parse(text(ra)).month === '2026-10', '月度统计聚合正常');

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
  assert(linkDoc.ok && /\/agent\.html#t=[A-Za-z0-9_-]{20,}/.test(linkDoc.url), 'link 生成 /agent.html#t=… 一次性安装链接');
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
  assert(/只读验证通过（采购记录 1 条）/.test(installOut), 'install 结束后执行只读验证');
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
  assert(!r3.isError && JSON.parse(text(r3)).items.length === 1, '新安装实例可立即只读访问');
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

  let reuseErr = null;
  try {
    runCli(['install', linkDoc.url, '--home', HOME3, '--agent', 'json', '--config', cfgFile, '--skill-dir', skillDir, '--local'], env3);
  } catch (e) {
    reuseErr = e;
  }
  assert(reuseErr && /无效、已过期或已被使用/.test(reuseErr.stderr || ''), '同一安装链接不能重复使用');

  let badErr = null;
  try {
    runCli(['install', 'https://example.com/agent.html#t=short', '--home', HOME3], env3);
  } catch (e) {
    badErr = e;
  }
  assert(badErr && /无法从链接中识别安装票据/.test(badErr.stderr || ''), '无效链接被拒绝且不发起兑换');

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

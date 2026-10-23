#!/usr/bin/env node
'use strict';
// purchase-app-mcp
// 默认以 stdio MCP 服务运行；另有 login / logout / status 三个本地命令。
// 凭据：每个安装实例用 App 账号登录，refresh token 仅存本机（0600），无共享硬编码 token。
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const pkg = require('./package.json');
const { AuthStore, resolveHomeDir } = require('./lib/store');
const { PublicApi } = require('./lib/publicapi');
const { interactiveLogin } = require('./lib/login');
const registerAllTools = require('./tools');

const DEFAULT_BASE_URL = 'https://121212121.top';
const NPX_LOGIN = 'npx -y github:begin2019510/purchase-app-mcp login';

function buildRuntime() {
  const store = new AuthStore(resolveHomeDir());
  const baseUrl = process.env.PURCHASE_APP_BASE_URL || DEFAULT_BASE_URL;
  const api = new PublicApi({ baseUrl, store, version: pkg.version });
  return { store, api };
}

function loginHint() {
  return '请在终端运行 `purchase-app-mcp login`（npx 安装时为 `' + NPX_LOGIN + '`）完成登录。';
}

async function cmdLogin(argv) {
  const { store, api } = buildRuntime();
  let username = '';
  const i = argv.indexOf('--username');
  if (i >= 0 && argv[i + 1]) username = argv[i + 1];
  let saved = null;
  try { saved = store.read(); } catch (e) { /* 损坏时仍允许重新登录 */ }
  username = process.env.PURCHASE_APP_USERNAME || username || (saved && saved.username) || 'admin';

  process.stderr.write('目标 App：' + api.baseUrl + '\n凭据文件：' + store.file + '\n');

  let out;
  const pw = process.env.PURCHASE_APP_PASSWORD;
  if (pw) {
    process.stderr.write('使用 PURCHASE_APP_PASSWORD 登录（密码不会写入磁盘）…\n');
    out = await api.login(username, pw);
  } else {
    out = await interactiveLogin({ api, username });
  }
  process.stdout.write('\n✅ 登录成功：' + out.username + '\n');
  process.stdout.write('凭据已保存（0600，仅 refresh token）：' + store.file + '\n');
}

async function cmdLogout() {
  const { store, api } = buildRuntime();
  await api.logout();
  process.stdout.write('✅ 已退出登录，本机凭据已删除：' + store.file + '\n');
  process.stdout.write('（App 服务端的 refresh token 也已尝试吊销）\n');
}

async function cmdStatus() {
  const { api } = buildRuntime();
  const s = api.status();
  process.stdout.write(
    'App 地址:     ' + s.baseUrl + '\n' +
    '凭据文件:     ' + s.authFile + '\n' +
    '审计日志:     ' + s.auditFile + '\n' +
    '登录状态:     ' + (s.loggedIn ? '已登录' : '未登录') + '\n' +
    '账号:         ' + (s.username || '-') + '\n' +
    'refresh 保存: ' + (s.refreshTokenStored ? '是' : '否') + '\n' +
    (s.baseMismatch ? '⚠️  凭据属于 ' + s.baseMismatch.stored + '，当前配置为 ' + s.baseMismatch.current + '\n' : '') +
    (s.storeError ? '⚠️  ' + s.storeError + '\n' : '') +
    (s.loggedIn ? '' : '\n' + loginHint() + '\n')
  );
}

async function runStdio() {
  const { store, api } = buildRuntime();
  const server = new McpServer({ name: 'purchase-app-mcp', version: pkg.version });
  registerAllTools(server, { api, log: (entry) => store.audit(entry) });

  store.audit({
    event: 'service_start',
    baseUrl: api.baseUrl,
    authenticated: api.loggedIn,
    username: api.identityName(),
    authFile: store.file,
  });

  if (!api.loggedIn) {
    process.stderr.write(
      '\n[purchase-app-mcp] 尚未登录（或凭据与当前 App 地址不匹配）。\n' +
      '数据工具会返回“未登录”错误，完成登录后即可使用：\n\n  ' +
      (process.env.PURCHASE_APP_MCP_HOME ? 'purchase-app-mcp login' : NPX_LOGIN) + '\n\n'
    );
    if (api.storeError) process.stderr.write('[purchase-app-mcp] ' + api.storeError + '\n');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function usage() {
  process.stdout.write(
    'purchase-app-mcp ' + pkg.version + ' —— 购买 App 的 MCP 数据接口\n\n' +
    '用法：\n' +
    '  purchase-app-mcp                以 stdio MCP 服务运行（agent 自动调用）\n' +
    '  purchase-app-mcp login          在本机网页登录（浏览器输入 App 账号密码）\n' +
    '  purchase-app-mcp logout         删除本机凭据并吊销服务端 refresh token\n' +
    '  purchase-app-mcp status         查看登录状态与凭据路径\n\n' +
    '环境变量：\n' +
    '  PURCHASE_APP_BASE_URL    App 地址，默认 ' + DEFAULT_BASE_URL + '\n' +
    '  PURCHASE_APP_MCP_HOME    凭据目录（可为每个 agent 指定独立目录）\n' +
    '  PURCHASE_APP_USERNAME    登录用户名（默认 admin）\n' +
    '  PURCHASE_APP_PASSWORD    仅用于无浏览器环境的一次性登录，不会保存\n'
  );
}

async function main() {
  const cmd = process.argv[2] || 'serve';
  if (cmd === 'serve' || cmd === 'stdio') return runStdio();
  if (cmd === 'login') return cmdLogin(process.argv.slice(3));
  if (cmd === 'logout') return cmdLogout();
  if (cmd === 'status') return cmdStatus();
  if (cmd === '--version' || cmd === '-v') { process.stdout.write(pkg.version + '\n'); return; }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return usage();
  process.stderr.write('未知命令：' + cmd + '\n\n');
  usage();
  process.exitCode = 2;
}

main().catch((e) => {
  process.stderr.write('❌ ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exitCode = 1;
});

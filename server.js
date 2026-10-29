#!/usr/bin/env node
'use strict';
// purchase-app-mcp
// 默认以 stdio MCP 服务运行；另有 login / logout / status 三个本地命令。
// 凭据：每个安装实例用 App 账号登录，refresh token 仅存本机（0600），无共享硬编码 token。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const pkg = require('./package.json');
const { AuthStore, resolveHomeDir } = require('./lib/store');
const { PublicApi, normalizeBaseUrl } = require('./lib/publicapi');
const { interactiveLogin } = require('./lib/login');
const registerAllTools = require('./tools');

const DEFAULT_BASE_URL = 'https://121212121.top';
const GITHUB_SPEC = 'github:begin2019510/purchase-app-mcp';
const SKILL_NAME = 'purchase-app';
const NPX_LOGIN = 'npx -y ' + GITHUB_SPEC + ' login';

function buildRuntime() {
  const store = new AuthStore(resolveHomeDir());
  const baseUrl = process.env.PURCHASE_APP_BASE_URL || DEFAULT_BASE_URL;
  const api = new PublicApi({ baseUrl, store, version: pkg.version });
  return { store, api };
}

function loginHint() {
  return '请在终端运行 `purchase-app-mcp login`（npx 安装时为 `' + NPX_LOGIN + '`）完成登录。';
}

// ---------- setup：自动注册 MCP + 安装 skill ----------

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function findOnPath(cmd) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* next */ }
  }
  return cmd;
}

function mcpEntry(home, local) {
  if (local) {
    // 从源码运行时直接指向本文件，避免本机访问 GitHub 慢导致 MCP 启动卡住
    return {
      command: process.execPath,
      args: [path.join(__dirname, 'server.js')],
      env: { PURCHASE_APP_MCP_HOME: home },
    };
  }
  return {
    command: findOnPath('npx'),
    args: ['-y', GITHUB_SPEC],
    env: { PURCHASE_APP_MCP_HOME: home },
  };
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function backupIfExists(file) {
  if (!fs.existsSync(file)) return null;
  const backup = file + '.bak-' + stamp();
  fs.copyFileSync(file, backup);
  try { fs.chmodSync(backup, 0o600); } catch (e) { /* ignore */ }
  return backup;
}

function writeJsonAtomic(file, obj, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode });
  try { fs.chmodSync(tmp, mode); } catch (e) { /* ignore */ }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch (e) { /* ignore */ }
}

function writeConfigEntry(configFile, entry) {
  let doc = {};
  if (fs.existsSync(configFile)) {
    try {
      doc = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (e) {
      throw new Error('配置文件不是合法 JSON，未做修改：' + configFile);
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('配置文件不是 JSON 对象，未做修改：' + configFile);
    }
  }
  const servers = doc.mcpServers && typeof doc.mcpServers === 'object' && !Array.isArray(doc.mcpServers)
    ? doc.mcpServers : {};
  const changed = JSON.stringify(servers['purchase-app'] || null) !== JSON.stringify(entry);
  if (!changed) return { changed: false, backup: null, configFile };
  const backup = backupIfExists(configFile);
  doc.mcpServers = servers;
  doc.mcpServers['purchase-app'] = entry;
  writeJsonAtomic(configFile, doc, 0o600);
  return { changed: true, backup, configFile };
}

function sameMcpEntry(a, b) {
  if (!a || !b) return false;
  const base = (p) => path.basename(String(p || ''));
  return base(a.command) === base(b.command) &&
    JSON.stringify(a.args || []) === JSON.stringify(b.args || []) &&
    JSON.stringify(a.env || {}) === JSON.stringify(b.env || {});
}

// 只读配置判断是否已注册，避免 `claude mcp get` 的联网健康检查拖慢/误判
function readUserMcpEntry(name) {
  const file = path.join(os.homedir(), '.claude.json');
  try {
    if (!fs.existsSync(file)) return { file, entry: null };
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const servers = doc && typeof doc === 'object' ? doc.mcpServers : null;
    return { file, entry: servers && typeof servers === 'object' ? servers[name] : null };
  } catch (e) {
    return { file, entry: null, error: e.message };
  }
}

function installSkill(skillDir) {
  const src = path.join(__dirname, 'skills', SKILL_NAME, 'SKILL.md');
  if (!fs.existsSync(src)) return { ok: false, error: 'skill 源文件缺失：' + src };
  fs.mkdirSync(skillDir, { recursive: true, mode: 0o755 });
  const target = path.join(skillDir, 'SKILL.md');
  const body = fs.readFileSync(src, 'utf8');
  let changed = true;
  let backup = null;
  if (fs.existsSync(target)) {
    const old = fs.readFileSync(target, 'utf8');
    if (old === body) changed = false;
    else {
      backup = target + '.bak-' + stamp();
      fs.copyFileSync(target, backup);
      try { fs.chmodSync(backup, 0o600); } catch (e) { /* ignore */ }
    }
  }
  if (changed) {
    const tmp = target + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, body, { mode: 0o644 });
    fs.renameSync(tmp, target);
    try { fs.chmodSync(target, 0o644); } catch (e) { /* ignore */ }
  }
  return { ok: true, target, changed, backup };
}

function setupNextSteps(home) {
  return [
    '',
    '凭据目录：' + home,
    '',
    '下一步（任选其一）：',
    '1) 登录（本机有浏览器，会自动打开登录页）：',
    '     npx -y ' + GITHUB_SPEC + ' login',
    '   或在 App「设置 → 连接 Agent」生成一次性安装链接后：',
    '     npx -y ' + GITHUB_SPEC + ' install <链接>',
    '   无浏览器（在独立 SSH 终端执行）：',
    '     read -rs PURCHASE_APP_PASSWORD',
    '     export PURCHASE_APP_PASSWORD',
    '     PURCHASE_APP_MCP_HOME=' + home + ' npx -y ' + GITHUB_SPEC + ' login',
    '     unset PURCHASE_APP_PASSWORD',
    '2) 重启当前 agent 会话（Claude Code 重启后用 /mcp 确认 purchase-app 已连接）',
    '3) 先调用只读工具 purchase.list 验证',
    '',
    '检查状态：npx -y ' + GITHUB_SPEC + ' status',
    '吊销凭据：npx -y ' + GITHUB_SPEC + ' logout',
  ].join('\n') + '\n';
}

async function cmdSetup(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    return v && !v.startsWith('--') ? v : true;
  };
  const printOnly = argv.includes('--print');
  let agent = flag('--agent');
  if (agent === true) agent = undefined;
  const home = path.resolve(expandHome(flag('--home') || process.env.PURCHASE_APP_MCP_HOME || resolveHomeDir()));
  const skillDir = path.resolve(expandHome(flag('--skill-dir') || path.join(os.homedir(), '.claude', 'skills', SKILL_NAME)));
  const configFlag = flag('--config');
  const configPath = configFlag && configFlag !== true ? path.resolve(expandHome(configFlag)) : null;
  const force = argv.includes('--force');
  const local = argv.includes('--local');
  const quiet = argv.includes('--quiet');
  const entry = mcpEntry(home, local);
  const skillSrc = path.join(__dirname, 'skills', SKILL_NAME, 'SKILL.md');

  if (printOnly || agent === 'generic') {
    process.stdout.write(JSON.stringify({
      mcpServers: { 'purchase-app': entry },
      skill: {
        source: skillSrc,
        sourceUrl: 'https://raw.githubusercontent.com/begin2019510/purchase-app-mcp/main/skills/purchase-app/SKILL.md',
        pageUrl: 'https://github.com/begin2019510/purchase-app-mcp/blob/main/skills/purchase-app/SKILL.md',
        target: path.join(skillDir, 'SKILL.md'),
      },
      commands: {
        login: 'npx -y ' + GITHUB_SPEC + ' login',
        logout: 'npx -y ' + GITHUB_SPEC + ' logout',
        status: 'npx -y ' + GITHUB_SPEC + ' status',
        setup: 'npx -y ' + GITHUB_SPEC + ' setup',
      },
    }, null, 2) + '\n');
    return;
  }

  if (agent === 'json' || configPath) {
    const file = configPath || path.join(os.homedir(), '.claude.json');
    const r = writeConfigEntry(file, entry);
    const s = installSkill(skillDir);
    process.stdout.write(
      (r.changed
        ? '✅ 已写入 MCP 配置：' + file + (r.backup ? '\n   备份：' + r.backup : '')
        : 'ℹ️  MCP 配置已存在且一致：' + file) + '\n' +
      (s.ok
        ? (s.changed ? '✅ 已安装 skill：' + s.target + (s.backup ? '\n   备份：' + s.backup : '') : 'ℹ️  skill 已是最新：' + s.target)
        : '⚠️  ' + s.error) + '\n' +
      (quiet ? '' : setupNextSteps(home))
    );
    return;
  }

  // 默认 Claude Code：优先用官方 CLI 注册，避免与运行中的 Claude 抢写配置文件
  const claudeBin = findOnPath('claude');
  let claudeOk = false;
  try {
    execFileSync(claudeBin, ['--version'], { stdio: 'ignore', timeout: 8000 });
    claudeOk = true;
  } catch (e) { claudeOk = false; }

  if (!claudeOk) {
    process.stderr.write('⚠️  未找到 claude CLI，改为直接写入 ~/.claude.json\n');
    const file = path.join(os.homedir(), '.claude.json');
    const r = writeConfigEntry(file, entry);
    const s = installSkill(skillDir);
    process.stdout.write(
      (r.changed ? '✅ 已写入 MCP 配置：' + file + (r.backup ? '\n   备份：' + r.backup : '') : 'ℹ️  MCP 配置已存在且一致：' + file) + '\n' +
      (s.ok ? (s.changed ? '✅ 已安装 skill：' + s.target : 'ℹ️  skill 已是最新：' + s.target) : '⚠️  ' + s.error) + '\n' +
      (quiet ? '' : setupNextSteps(home))
    );
    return;
  }

  const existing = readUserMcpEntry('purchase-app');
  const already = !force && sameMcpEntry(existing.entry, entry);

  let regOutput = '';
  if (already) {
    regOutput = 'ℹ️  Claude Code 已注册且配置一致（跳过注册；如需更新用 --force）\n';
  } else {
    // 已有配置但不一致（例如换了凭据目录）时先移除；失败则交给下面的回退写入
    if (existing.entry) {
      try { execFileSync(claudeBin, ['mcp', 'remove', 'purchase-app', '-s', 'user'], { stdio: 'ignore', timeout: 15000 }); } catch (e) { /* ignore */ }
    }
    try {
      execFileSync(claudeBin, [
        'mcp', 'add', 'purchase-app', '-s', 'user',
        '-e', 'PURCHASE_APP_MCP_HOME=' + home,
        '--', entry.command, ...entry.args,
      ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, encoding: 'utf8' });
      regOutput = (existing.entry ? '✅ 已更新' : '✅ 已在') + ' Claude Code（User scope）注册 purchase-app\n';
    } catch (e) {
      regOutput = '⚠️  claude mcp add 失败，回退为直接写 ~/.claude.json\n';
      const r = writeConfigEntry(path.join(os.homedir(), '.claude.json'), entry);
      if (r.changed) regOutput += '✅ 已写入 MCP 配置：' + r.configFile + (r.backup ? '（备份：' + r.backup + '）' : '') + '\n';
      else regOutput += 'ℹ️  配置文件已存在且一致：' + r.configFile + '\n';
    }
  }

  const s = installSkill(skillDir);
  process.stdout.write(
    regOutput +
    (s.ok
      ? (s.changed ? '✅ 已安装 skill：' + s.target + (s.backup ? '\n   备份：' + s.backup : '') : 'ℹ️  skill 已是最新：' + s.target)
      : '⚠️  ' + s.error) + '\n' +
    (quiet ? '' : setupNextSteps(home))
  );
}

function applyHomeFlag(argv) {
  const h = argValue(argv, '--home');
  if (h) process.env.PURCHASE_APP_MCP_HOME = path.resolve(expandHome(h));
}

async function cmdLogin(argv) {
  applyHomeFlag(argv);
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
    out = await interactiveLogin({ api, username, autoOpen: !argv.includes('--no-open') });
  }
  process.stdout.write('\n✅ 登录成功：' + out.username + '\n');
  process.stdout.write('凭据已保存（0600，仅 refresh token）：' + store.file + '\n');
}

// 解析 App 设置页生成的一次性安装链接（票据放在 #t= 片段里，不会随请求发给服务器）
function parseInstallLink(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let u = null;
  try { u = new URL(s); } catch (e) { u = null; }
  if (!u) {
    return /^[A-Za-z0-9_-]{20,200}$/.test(s) ? { ticket: s, baseUrl: null } : null;
  }
  const hash = new URLSearchParams((u.hash || '').replace(/^#/, ''));
  const ticket = hash.get('t') || hash.get('ticket') ||
    u.searchParams.get('t') || u.searchParams.get('ticket');
  if (!ticket || !/^[A-Za-z0-9_-]{20,200}$/.test(ticket)) return null;
  return { ticket, baseUrl: /^https?:$/.test(u.protocol) ? u.origin : null };
}

function positionalArgs(argv, valueFlags) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (valueFlags.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

// install <链接>：注册 MCP/装 skill → 用一次性票据换独立凭据 → 只读验证。
// 全程不需要密码，也不需要用户做端口转发；适合把链接直接交给 agent。
async function cmdInstall(argv) {
  applyHomeFlag(argv);
  const linkArg = positionalArgs(argv, ['--home', '--skill-dir', '--agent', '--config'])[0];
  if (!linkArg) {
    throw new Error('用法：purchase-app-mcp install <App 设置页生成的安装链接> [--home <目录>]');
  }
  const link = parseInstallLink(linkArg);
  if (!link) {
    throw new Error('无法从链接中识别安装票据。请完整复制 App 设置页生成的链接（形如 https://…/agent#t=…）。');
  }

  // 链接所属的 App 地址优先；若显式配置了不同地址则拒绝，避免把票据发给别的服务
  if (link.baseUrl) {
    const fromLink = normalizeBaseUrl(link.baseUrl);
    if (process.env.PURCHASE_APP_BASE_URL) {
      const configured = normalizeBaseUrl(process.env.PURCHASE_APP_BASE_URL);
      if (configured !== fromLink) {
        throw new Error('安装链接属于 ' + fromLink + '，但当前 PURCHASE_APP_BASE_URL 是 ' + configured + '；请先 unset 或改成同一地址。');
      }
    }
    process.env.PURCHASE_APP_BASE_URL = fromLink;
  }

  const setupArgs = ['--quiet', '--home', resolveHomeDir()];
  for (const name of ['--skill-dir', '--agent', '--config']) {
    const v = argValue(argv, name);
    if (v) setupArgs.push(name, v);
  }
  if (argv.includes('--local')) setupArgs.push('--local');
  if (argv.includes('--force')) setupArgs.push('--force');

  await cmdSetup(setupArgs);

  const { store, api } = buildRuntime();
  if (api.loggedIn) {
    process.stderr.write('ℹ️  将用安装链接替换本机现有凭据（原账号：' + api.identityName() + '）\n');
  }
  const out = await api.exchangeAgentTicket(link.ticket);

  process.stdout.write('\n✅ 安装并授权成功：' + out.username + '\n');
  process.stdout.write('App 地址：' + api.baseUrl + '\n');
  process.stdout.write('凭据已保存（0600，仅 refresh token）：' + store.file + '\n');

  if (!argv.includes('--no-verify')) {
    try {
      const list = await api.get('/api/items');
      const n = Array.isArray(list) ? list.length
        : (list && Array.isArray(list.items) ? list.items.length : 0);
      process.stdout.write('✅ 只读验证通过（采购记录 ' + n + ' 条）\n');
    } catch (e) {
      process.exitCode = 1;
      process.stderr.write('⚠️  凭据已保存，但只读验证失败：' + e.message + '\n');
    }
  }

  process.stdout.write('\n下一步：重启当前 agent 会话以加载 MCP（Claude Code 用 /mcp 确认），然后调用 purchase.list。\n');
  process.stdout.write('INSTALL_OK username=' + out.username + ' base=' + api.baseUrl + '\n');
}

// link：已登录时生成一次性安装链接，发给另一个 agent 使用。
async function cmdLink(argv) {
  applyHomeFlag(argv);
  const { api } = buildRuntime();
  if (!api.loggedIn) {
    throw new Error('当前未登录。请先运行 login，或在 App 设置页直接生成安装链接。');
  }
  const r = await api.createAgentTicket();
  process.stdout.write(JSON.stringify({
    ok: true,
    url: r.url,
    expiresAt: r.expiresAt,
    command: 'npx -y ' + GITHUB_SPEC + ' install ' + JSON.stringify(r.url),
  }, null, 2) + '\n');
  process.stderr.write('\n把 url 发给 agent 即可（10 分钟内有效、只能使用一次）。\n');
}

async function cmdLogout(argv) {
  applyHomeFlag(argv);
  const { store, api } = buildRuntime();
  await api.logout();
  process.stdout.write('✅ 已退出登录，本机凭据已删除：' + store.file + '\n');
  process.stdout.write('（App 服务端的 refresh token 也已尝试吊销）\n');
}

async function cmdStatus(argv) {
  applyHomeFlag(argv);
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
      '数据工具会返回“未登录”错误。可以：\n' +
      '  1) 运行 ' + (process.env.PURCHASE_APP_MCP_HOME ? 'purchase-app-mcp login' : NPX_LOGIN) + ' 在本机网页登录\n' +
      '  2) 在 App 设置页生成一次性安装链接，运行 install <链接>（无需密码）\n\n'
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
    '  purchase-app-mcp setup          自动注册 MCP 到 Claude Code 并安装 skill\n' +
    '  purchase-app-mcp setup --print  只输出 JSON 配置（其他 agent / 不写文件）\n' +
    '  purchase-app-mcp install <链接> 用一次性安装链接自动完成注册、授权和只读验证\n' +
    '  purchase-app-mcp link           已登录时生成一次性安装链接（给另一个 agent）\n' +
    '  purchase-app-mcp login          在本机网页登录（有桌面会自动打开浏览器）\n' +
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
  if (cmd === 'setup') return cmdSetup(process.argv.slice(3));
  if (cmd === 'install') return cmdInstall(process.argv.slice(3));
  if (cmd === 'link') return cmdLink(process.argv.slice(3));
  if (cmd === 'login') return cmdLogin(process.argv.slice(3));
  if (cmd === 'logout') return cmdLogout(process.argv.slice(3));
  if (cmd === 'status') return cmdStatus(process.argv.slice(3));
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

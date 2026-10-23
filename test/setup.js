'use strict';
// setup 命令测试：只写临时目录，不触碰真实的 ~/.claude.json
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin/purchase-app-mcp.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pamcp-setup-'));

function assert(c, m) {
  if (!c) { console.error('❌ ' + m); process.exit(1); }
  console.log('✓ ' + m);
}
function run(args, env) {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const home = path.join(TMP, 'home');
const env = { PURCHASE_APP_MCP_HOME: home };

const printed = run(['setup', '--print', '--home', home], env);
const cfg = JSON.parse(printed);
const entry = cfg.mcpServers['purchase-app'];
assert(entry && entry.args.includes('github:begin2019510/purchase-app-mcp'), '--print 输出可用的 MCP 配置');
assert(entry.env && entry.env.PURCHASE_APP_MCP_HOME === home, '--print 绑定凭据目录');
assert(cfg.skill && fs.existsSync(cfg.skill.source), '--print 指向随包分发的 SKILL.md');
assert(!fs.existsSync(path.join(home, 'auth.json')), 'setup 不创建凭据、不需要登录');
assert(!/testpass|refreshToken/.test(printed), '--print 不含密码/token');

const agentCfg = path.join(TMP, 'agent.json');
fs.writeFileSync(agentCfg, JSON.stringify({ keep: 123, mcpServers: { other: { command: 'x' } } }, null, 2));
const skillDir = path.join(TMP, 'skills');
const out1 = run(['setup', '--agent', 'json', '--config', agentCfg, '--skill-dir', skillDir, '--home', home], env);

const doc = JSON.parse(fs.readFileSync(agentCfg, 'utf8'));
assert(doc.keep === 123 && doc.mcpServers.other.command === 'x', '写入时保留配置文件里的其他内容');
assert(doc.mcpServers['purchase-app'].env.PURCHASE_APP_MCP_HOME === home, 'JSON 模式写入正确的 MCP 条目');
assert((fs.statSync(agentCfg).mode & 0o777) === 0o600, '配置文件权限为 0600');
assert(/已写入 MCP 配置/.test(out1), '首次写入有明确提示');

const skillFile = path.join(skillDir, 'SKILL.md');
assert(fs.existsSync(skillFile), 'skill 已安装到目标目录');
assert(/^---\nname: purchase-app/m.test(fs.readFileSync(skillFile, 'utf8')), 'SKILL.md frontmatter 正确');
assert((fs.statSync(skillFile).mode & 0o777) === 0o644, 'SKILL.md 权限为 0644');

const bakBefore = fs.readdirSync(TMP).filter(f => f.startsWith('agent.json.bak-')).length;
const out2 = run(['setup', '--agent', 'json', '--config', agentCfg, '--skill-dir', skillDir, '--home', home], env);
const bakAfter = fs.readdirSync(TMP).filter(f => f.startsWith('agent.json.bak-')).length;
assert(bakAfter === bakBefore, '重复 setup 不做无意义的备份');
assert(/已存在且一致/.test(out2) && /skill 已是最新/.test(out2), 'setup 幂等');
assert(!/testpass|refreshToken/.test(out1 + out2), 'setup 输出不含密码/token');

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n✅ setup 测试通过\n');

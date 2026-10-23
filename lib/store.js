'use strict';
// 本机凭据存储：只保存 refresh token（以及用户名/baseUrl），不保存密码。
// 目录 0700、文件 0600、原子写入；PURCHASE_APP_MCP_HOME 可为每个 agent 指定独立目录。
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR_NAME = 'purchase-app-mcp';

function resolveHomeDir() {
  if (process.env.PURCHASE_APP_MCP_HOME) return path.resolve(process.env.PURCHASE_APP_MCP_HOME);
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, DIR_NAME);
}

class AuthStore {
  constructor(dir) {
    this.dir = dir || resolveHomeDir();
    this.file = path.join(this.dir, 'auth.json');
    this.auditFile = path.join(this.dir, 'audit.log');
    this.lockFile = path.join(this.dir, 'auth.lock');
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch (e) { /* 某些文件系统不支持 */ }
  }

  read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new Error('无法读取凭据文件 ' + this.file + '：' + e.message);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error('凭据文件已损坏：' + this.file + '（删除后重新 login 即可）');
    }
    if (!data || typeof data.refreshToken !== 'string' || !data.refreshToken) return null;
    return data;
  }

  save(data) {
    this.ensureDir();
    const tmp = this.file + '.' + process.pid + '.' + Date.now() + '.tmp';
    const body = JSON.stringify(data, null, 2) + '\n';
    try {
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch (e) { /* ignore */ }
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* already renamed */ }
    }
  }

  clear() {
    try {
      fs.unlinkSync(this.file);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  audit(entry) {
    try {
      this.ensureDir();
      const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry }) + '\n';
      fs.appendFileSync(this.auditFile, line, { mode: 0o600 });
      try { fs.chmodSync(this.auditFile, 0o600); } catch (e) { /* ignore */ }
    } catch (e) {
      // 审计失败不能影响工具调用，但要在 stderr 提示（stdout 是 MCP 协议通道）
      process.stderr.write('[purchase-app-mcp] audit log failed: ' + e.message + '\n');
    }
  }

  // 跨进程互斥：同一 auth.json 被多个 MCP 进程共用时，刷新令牌轮换必须串行
  async withLock(fn, { timeoutMs = 20000, staleMs = 60000 } = {}) {
    this.ensureDir();
    const started = Date.now();
    let fd = null;
    while (fd === null) {
      try {
        fd = fs.openSync(this.lockFile, 'wx', 0o600);
        fs.writeFileSync(fd, String(process.pid));
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const st = fs.statSync(this.lockFile);
          if (Date.now() - st.mtimeMs > staleMs) { fs.unlinkSync(this.lockFile); continue; }
        } catch (e2) { continue; }
        if (Date.now() - started > timeoutMs) {
          throw new Error('等待凭据锁超时（' + this.lockFile + '）。请检查是否有其他进程卡住。');
        }
        await new Promise(r => setTimeout(r, 80));
      }
    }
    try {
      return await fn();
    } finally {
      try { fs.closeSync(fd); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(this.lockFile); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { AuthStore, resolveHomeDir };

'use strict';
// 本地 mock App API：验证 MCP 的鉴权生命周期（不接触真实数据）
const http = require('http');
const { URL } = require('url');

let currentRefresh = 'rt1';
const refreshTokens = new Set(['rt1']); // 同一账号可同时持有多个会话的 refresh token
let validAccess = new Set(['jwt1']);
let seq = 1;
let refreshCount = 0;
let logoutCount = 0;
let ticketSeq = 0;
const agentTickets = new Map(); // ticket -> { used:false }
const installRefresh = new Set(); // 安装链接签发的独立 refresh token（可与 primary 并存）

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const items = [{
  id: 'rec_mock_1',
  '商品名称': '测试商品',
  '平台': '京东',
  '单价': 99,
  '数量': 2,
  '状态': '已下单',
  '分类': '数码',
  '日期': Date.now(),
  '备注': 'mock',
  '项目ID': 'p1',
  '阶段': 0,
}];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let body = {};
  if (req.method !== 'GET') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) { try { body = JSON.parse(raw); } catch (e) { body = {}; } }
  }

  if (url.pathname === '/__state') {
    return json(res, 200, { currentRefresh, refreshCount, logoutCount, validAccess: [...validAccess], seq });
  }
  if (url.pathname === '/__invalidate_access') {
    validAccess.clear();
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/auth') {
    const action = url.searchParams.get('action');
    if (action === 'login') {
      if (body.username === 'admin' && body.password === 'testpass') {
        validAccess.clear();
        validAccess.add('jwt_login_' + seq);
        currentRefresh = 'rt_' + (seq++);
        refreshTokens.add(currentRefresh);
        return json(res, 200, { ok: true, token: [...validAccess][0], refreshToken: currentRefresh, username: 'admin' });
      }
      return json(res, 401, { error: '用户名或密码错误' });
    }
    if (action === 'refresh') {
      const rt = body.refreshToken;
      const primary = !!rt && refreshTokens.has(rt);
      const installer = !!rt && installRefresh.has(rt);
      if (!primary && !installer) {
        return json(res, 401, { error: 'Refresh token 无效或已过期' });
      }
      refreshCount++;
      const t = 'jwt_refresh_' + (seq++);
      validAccess.add(t);
      let next;
      if (installer) {
        // 安装凭据独立轮换，不影响主会话
        installRefresh.delete(rt);
        next = 'rt_install_' + (seq++);
        installRefresh.add(next);
      } else {
        refreshTokens.delete(rt);
        currentRefresh = 'rt_' + (seq++);
        refreshTokens.add(currentRefresh);
        next = currentRefresh;
      }
      return json(res, 200, { ok: true, token: t, refreshToken: next });
    }
    if (action === 'logout') {
      logoutCount++;
      if (body.refreshToken) {
        refreshTokens.delete(body.refreshToken);
        installRefresh.delete(body.refreshToken);
        if (body.refreshToken === currentRefresh) currentRefresh = '';
      }
      return json(res, 200, { ok: true });
    }
    if (action === 'agent-ticket') {
      if (!validAccess.has(token)) return json(res, 401, { error: 'Unauthorized' });
      const ticket = 'ticket_' + (++ticketSeq) + '_' + 'x'.repeat(32);
      agentTickets.set(ticket, { used: false });
      return json(res, 200, { ok: true, ticket, expiresAt: new Date(Date.now() + 600000).toISOString() });
    }
    if (action === 'agent-exchange') {
      const rec = agentTickets.get(body.ticket);
      if (!rec || rec.used) return json(res, 401, { error: '安装链接无效、已过期或已被使用' });
      rec.used = true;
      const rt = 'rt_install_' + (seq++);
      const t = 'jwt_install_' + (seq++);
      installRefresh.add(rt);
      validAccess.add(t);
      return json(res, 200, { ok: true, token: t, refreshToken: rt, username: 'admin' });
    }
    return json(res, 400, { error: 'Unknown action' });
  }

  // 业务接口：除 /api/phases 外都要求有效 access token
  if (!validAccess.has(token)) return json(res, 401, { error: '未授权：请登录' });

  if (url.pathname === '/api/items') {
    if (req.method === 'GET') return json(res, 200, items);
    if (req.method === 'POST') return json(res, 200, { id: 'rec_new' });
    if (req.method === 'PUT') return json(res, 200, { ok: true });
    if (req.method === 'DELETE') return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/expenses') {
    if (req.method === 'GET') return json(res, 200, []);
    return json(res, 200, { id: 'rec_e1' });
  }
  if (url.pathname === '/api/todos') {
    if (req.method === 'GET') return json(res, 200, []);
    return json(res, 200, { id: 'rec_t1' });
  }
  if (url.pathname === '/api/projects') {
    if (req.method === 'GET') return json(res, 200, []);
    return json(res, 200, { id: 'p1' });
  }
  if (url.pathname === '/api/budgets') {
    if (req.method === 'GET') return json(res, 200, { ok: true, data: { '2026-10': { total: 1000 } } });
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/recurring' || url.pathname === '/api/cats') {
    if (req.method === 'GET') return json(res, 200, { ok: true, data: {} });
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/phases') {
    // 模拟公网缺失该端点时 CF Pages 的 SPA 回退
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><html><body>app</body></html>');
  }
  return json(res, 404, { error: 'not found' });
});

server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: server.address().port }));
});

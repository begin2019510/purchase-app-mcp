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

// 两级模型（与 App /api/needs rowToNeed 同形）：读路径优先走这里。
// 排列方向与服务端一致：ORDER BY id DESC（新→旧），用于验证 limit 不被截反。
const needs = [{
  id: 'rec_mock_1',
  '名称': '测试商品',
  '分类': '数码',
  '预算下限': null,
  '预算上限': null,
  '状态': '已定点',
  '维度': [],
  '定点供应商ID': 'rec_s1',
  '定点供应商IDs': ['rec_s1'],
  '项目ID': 'p1',
  '阶段': 0,
  '虚拟': '',
  '极速': '',
  '历史': '',
  '取消原因': '',
  '定点时间': '',
  '创建时间': '2026-10-01 10:00',
  suppliers: [{
    id: 'rec_s1',
    needId: 'rec_mock_1',
    '谁': '京东',
    '平台': '京东',
    '报价': 99,
    '图片': '',
    '优点': '',
    '缺点': '',
    '备注': '',
    '打分': {},
    '排序': 0,
  }],
  orders: [{
    id: 'rec_o1',
    needId: 'rec_mock_1',
    supplierId: 'rec_s1',
    role: 'formal',
    '数量': 2,
    '实付': 99,
    '状态': '已下单',
    '分期期数': 0,
    '分期金额': 0,
    '分期开始月': '',
    '分期已还': 0,
    '日期': Date.now(),
    '图片': '',
    '备注': 'mock',
    '极速': '',
    '创建时间': '2026-10-01 10:00',
    '审批时间': '',
    '下单时间': '',
    '到货时间': '',
    '归档时间': '',
  }],
}, {
  // 无子单的近对比中需求：date=null，靠「创建时间」参与倒序（最新在前）
  id: 'rec_mock_2',
  '名称': '近期对比中',
  '分类': '日用品',
  '预算下限': null,
  '预算上限': null,
  '状态': '对比中',
  '维度': [],
  '项目ID': '',
  '阶段': null,
  '虚拟': '',
  '极速': '',
  '历史': '',
  '取消原因': '',
  '定点时间': '',
  '创建时间': '2026-11-15 12:00',
  suppliers: [],
  orders: [],
}, {
  // 更早的对比中需求：应被排到最后
  id: 'rec_mock_0',
  '名称': '九月旧需求',
  '分类': '其他',
  '预算下限': null,
  '预算上限': null,
  '状态': '对比中',
  '维度': [],
  '项目ID': '',
  '阶段': null,
  '虚拟': '',
  '极速': '',
  '历史': '',
  '取消原因': '',
  '定点时间': '',
  '创建时间': '2026-09-01 09:00',
  suppliers: [],
  orders: [],
}];

// 记账夹具：服务端 /api/expenses 为 ORDER BY id（旧→新），验证倒序后 limit 取最新
const expenses = [
  {
    id: 'rec_e1',
    '日期': '2026-10-05',
    '类型': '支出',
    '分类': '餐饮',
    '金额': 10,
    '备注': '旧',
    '分摊周数': 0,
    '分摊开始周': '',
    '图片': '',
    '项目ID': '',
    '阶段': null,
  },
  {
    id: 'rec_e2',
    '日期': '2026-10-15',
    '类型': '支出',
    '分类': '交通',
    '金额': 20,
    '备注': '中',
    '分摊周数': 0,
    '分摊开始周': '',
    '图片': '',
    '项目ID': '',
    '阶段': null,
  },
  {
    id: 'rec_e3',
    '日期': '2026-11-01',
    '类型': '支出',
    '分类': '购物',
    '金额': 30,
    '备注': '新',
    '分摊周数': 0,
    '分摊开始周': '',
    '图片': '',
    '项目ID': '',
    '阶段': null,
  },
];

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

  if (url.pathname === '/api/needs') {
    // 两级模型读路径（MCP 优先）
    if (req.method === 'GET') return json(res, 200, needs);
    return json(res, 405, { error: 'Method Not Allowed' });
  }
  if (url.pathname === '/api/items') {
    if (req.method === 'GET') return json(res, 200, items);
    if (req.method === 'POST') return json(res, 200, { id: 'rec_new' });
    if (req.method === 'PUT') return json(res, 200, { ok: true });
    if (req.method === 'DELETE') return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/expenses') {
    if (req.method === 'GET') return json(res, 200, expenses);
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

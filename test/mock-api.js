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

// 项目/待办夹具（v1.4.0 写路径与 T1 confirm 校验用）
const projects = [{
  id: 'p1',
  name: '测试项目',
  description: '',
  dueDate: '',
  status: '进行中',
  color: '',
  budget: null,
  currentPhase: 0,
  phases: [],
  items: [],
  spend: { buy: 0, exp: 0 },
}];
const todos = [{
  id: 'rec_t1',
  title: '测试待办',
  description: '',
  dueDate: '',
  status: '待办',
  priority: '中',
  category: '',
  repeat: '无',
  projectId: '',
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

  // ---- needs 两级模型（v1.4.0 写路径）----
  const findNeed = (id) => needs.find(n => n.id === id) || null;
  const findSupplier = (id) => {
    for (const n of needs) {
      const s = (n.suppliers || []).find(x => x.id === id);
      if (s) return { need: n, supplier: s };
    }
    return null;
  };
  const findOrder = (id) => {
    for (const n of needs) {
      const o = (n.orders || []).find(x => x.id === id);
      if (o) return { need: n, order: o };
    }
    return null;
  };
  const nowDt = '2026-11-18 12:00';
  let m;

  if (url.pathname === '/api/needs') {
    if (req.method === 'GET') return json(res, 200, needs);
    if (req.method === 'POST') {
      const id = 'rec_n' + (++seq);
      needs.unshift({
        id,
        '名称': String(body.name || '').trim(),
        '分类': body.category || '其他',
        '预算下限': body.budgetMin === undefined ? null : body.budgetMin,
        '预算上限': body.budgetMax === undefined ? null : body.budgetMax,
        '状态': '对比中',
        '维度': [],
        '项目ID': body.projectId || '',
        '阶段': body.phaseIdx === undefined ? null : body.phaseIdx,
        '虚拟': body.virtual ? '1' : '',
        '极速': '',
        '历史': '',
        '取消原因': '',
        '定点时间': '',
        '创建时间': nowDt,
        suppliers: [],
        orders: [],
      });
      return json(res, 200, { id });
    }
    return json(res, 405, { error: 'Method Not Allowed' });
  }
  if ((m = url.pathname.match(/^\/api\/needs\/([^/]+)$/))) {
    const need = findNeed(decodeURIComponent(m[1]));
    if (req.method === 'PUT') {
      if (!need) return json(res, 404, { error: 'not found' });
      if (body.name !== undefined) need['名称'] = String(body.name);
      if (body.category !== undefined) need['分类'] = body.category;
      if (body.budgetMin !== undefined) need['预算下限'] = body.budgetMin;
      if (body.budgetMax !== undefined) need['预算上限'] = body.budgetMax;
      if (body.projectId !== undefined) need['项目ID'] = body.projectId;
      if (body.phaseIdx !== undefined) need['阶段'] = body.phaseIdx;
      if (body.cancelReason !== undefined) need['取消原因'] = String(body.cancelReason || '');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      if (need) {
        const i = needs.indexOf(need);
        if (i >= 0) needs.splice(i, 1);
      }
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Method Not Allowed' });
  }
  if ((m = url.pathname.match(/^\/api\/needs\/([^/]+)\/suppliers$/)) && req.method === 'POST') {
    const need = findNeed(decodeURIComponent(m[1]));
    if (!need) return json(res, 404, { error: '需求不存在' });
    if (need['状态'] !== '对比中' && need['状态'] !== '已定点') {
      return json(res, 400, { error: '当前状态不可添加供应商' });
    }
    const id = 'rec_s' + (++seq);
    need.suppliers.push({
      id,
      needId: need.id,
      '谁': String(body.name || '').trim(),
      '平台': body.platform || '',
      '报价': body.price === undefined ? null : body.price,
      '图片': '',
      '优点': body.pros || '',
      '缺点': body.cons || '',
      '备注': body.note || '',
      '打分': body.scores && typeof body.scores === 'object' ? body.scores : {},
      '排序': need.suppliers.length,
    });
    return json(res, 200, { id });
  }
  if ((m = url.pathname.match(/^\/api\/needs\/([^/]+)\/decide$/)) && req.method === 'POST') {
    const need = findNeed(decodeURIComponent(m[1]));
    if (!need) return json(res, 404, { error: '需求不存在' });
    if (need['状态'] === '已完成' || need['状态'] === '已取消') {
      return json(res, 400, { error: '需求已结束' });
    }
    const supHit = findSupplier(String(body.supplierId || ''));
    if (!supHit || supHit.need !== need) return json(res, 404, { error: '供应商不存在' });
    need['状态'] = '已定点';
    need['定点时间'] = nowDt;
    need['定点供应商ID'] = supHit.supplier.id;
    need['定点供应商IDs'] = need.orders
      .filter(o => o.role === 'formal')
      .map(o => o.supplierId)
      .concat([supHit.supplier.id])
      .filter((v, i, a) => a.indexOf(v) === i);
    let formal = need.orders.find(o => o.role === 'formal' && o.supplierId === supHit.supplier.id);
    if (!formal) {
      formal = {
        id: 'rec_o' + (++seq),
        needId: need.id,
        supplierId: supHit.supplier.id,
        role: 'formal',
        '数量': body.qty !== undefined ? Number(body.qty) : 1,
        '实付': body.pricePaid !== undefined ? Number(body.pricePaid)
          : (supHit.supplier['报价'] != null ? Number(supHit.supplier['报价']) : 0),
        '状态': '待下单',
        '分期期数': 0,
        '分期金额': 0,
        '分期开始月': '',
        '分期已还': 0,
        '日期': null,
        '图片': '',
        '备注': body.note || '',
        '极速': '',
        '创建时间': nowDt,
        '审批时间': '',
        '下单时间': '',
        '到货时间': '',
        '归档时间': '',
      };
      need.orders.push(formal);
    } else {
      if (body.pricePaid !== undefined) formal['实付'] = Number(body.pricePaid);
      if (body.qty !== undefined) formal['数量'] = Number(body.qty);
      if (body.note !== undefined) formal['备注'] = String(body.note || '');
    }
    return json(res, 200, { ok: true, orderId: formal.id });
  }
  if ((m = url.pathname.match(/^\/api\/needs\/([^/]+)\/undecided$/)) && req.method === 'POST') {
    const need = findNeed(decodeURIComponent(m[1]));
    if (!need) return json(res, 404, { error: 'not found' });
    if (need['状态'] !== '已定点') return json(res, 400, { error: '需求未定点' });
    const formals = need.orders.filter(o => o.role === 'formal');
    let target = null;
    if (body.supplierId) {
      target = formals.find(o => o.supplierId === String(body.supplierId)) || null;
      if (!target) return json(res, 400, { error: '该供应商没有正式单' });
    } else {
      if (formals.length > 1) return json(res, 400, { error: '该需求有多家定点，请指定要回退的供应商' });
      target = formals[0] || null;
    }
    if (target && target['状态'] !== '待下单') {
      return json(res, 400, { error: '该供应商正式单已下单，不可回退定点' });
    }
    if (target) need.orders = need.orders.filter(o => o !== target);
    const rest = need.orders.filter(o => o.role === 'formal');
    if (rest.length) {
      need['状态'] = '已定点';
      need['定点供应商ID'] = rest[0].supplierId;
      need['定点供应商IDs'] = rest.map(o => o.supplierId);
    } else {
      need['状态'] = '对比中';
      need['定点供应商ID'] = '';
      need['定点供应商IDs'] = [];
      need['定点时间'] = '';
    }
    return json(res, 200, { ok: true, remaining: rest.length });
  }
  if ((m = url.pathname.match(/^\/api\/needs\/([^/]+)\/cancel$/)) && req.method === 'POST') {
    const need = findNeed(decodeURIComponent(m[1]));
    if (!need) return json(res, 404, { error: 'not found' });
    if (need['状态'] === '已完成') return json(res, 400, { error: '需求已完成，不可取消' });
    if (need['状态'] === '已取消') return json(res, 200, { ok: true });
    const spent = (need.orders || []).some(o =>
      ['已下单', '已到', '已归档'].includes(o['状态']));
    if (spent) return json(res, 400, { error: '已有入账子单，不可取消需求（请先退货或归档）' });
    for (const o of need.orders) {
      if (!['已归档', '已取消'].includes(o['状态'])) o['状态'] = '已取消';
    }
    need['状态'] = '已取消';
    need['取消原因'] = String(body.reason || body.cancelReason || '').slice(0, 200);
    return json(res, 200, { ok: true });
  }
  if ((m = url.pathname.match(/^\/api\/suppliers\/([^/]+)$/))) {
    const hit = findSupplier(decodeURIComponent(m[1]));
    if (req.method === 'PUT') {
      if (!hit) return json(res, 404, { error: 'not found' });
      const s = hit.supplier;
      if (body.name !== undefined) s['谁'] = String(body.name);
      if (body.price !== undefined) s['报价'] = body.price;
      if (body.platform !== undefined) s['平台'] = String(body.platform || '');
      if (body.pros !== undefined) s['优点'] = String(body.pros || '');
      if (body.cons !== undefined) s['缺点'] = String(body.cons || '');
      if (body.note !== undefined) s['备注'] = String(body.note || '');
      if (body.sortOrder !== undefined) s['排序'] = Number(body.sortOrder) || 0;
      if (body.scores !== undefined && body.scores && typeof body.scores === 'object') {
        s['打分'] = body.scores;
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      if (hit) {
        const arr = hit.need.suppliers;
        arr.splice(arr.indexOf(hit.supplier), 1);
      }
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Method Not Allowed' });
  }
  if ((m = url.pathname.match(/^\/api\/orders\/([^/]+)\/transition$/)) && req.method === 'POST') {
    const hit = findOrder(decodeURIComponent(m[1]));
    if (!hit) return json(res, 404, { error: 'not found' });
    const VALID = ['待下单', '已下单', '已到', '已退', '已归档', '已取消'];
    if (!VALID.includes(String(body.to || ''))) return json(res, 400, { error: '无效状态' });
    hit.order['状态'] = String(body.to);
    if (body.note !== undefined) hit.order['备注'] = String(body.note || '');
    if (body.to === '已下单') hit.order['下单时间'] = nowDt;
    if (body.to === '已到') hit.order['到货时间'] = nowDt;
    if (body.to === '已归档') hit.order['归档时间'] = nowDt;
    return json(res, 200, { ok: true });
  }
  if ((m = url.pathname.match(/^\/api\/orders\/([^/]+)$/)) && req.method === 'PUT') {
    const hit = findOrder(decodeURIComponent(m[1]));
    if (!hit) return json(res, 404, { error: 'not found' });
    const o = hit.order;
    if (['已归档', '已取消'].includes(o['状态'])) {
      return json(res, 400, { error: '已归档/已取消的子单不可修改' });
    }
    if (body.qty !== undefined) o['数量'] = Number(body.qty) || 1;
    if (body.pricePaid !== undefined) o['实付'] = Number(body.pricePaid) || 0;
    if (body.installments !== undefined) o['分期期数'] = Number(body.installments) || 0;
    if (body.installmentAmount !== undefined) o['分期金额'] = Number(body.installmentAmount) || 0;
    if (body.installmentStart !== undefined) o['分期开始月'] = String(body.installmentStart || '');
    if (body.installmentPaid !== undefined) o['分期已还'] = Number(body.installmentPaid) || 0;
    if (body.date !== undefined) o['日期'] = body.date == null ? null : Date.parse(body.date) || o['日期'];
    if (body.note !== undefined) o['备注'] = String(body.note || '');
    if (body.setImage !== undefined || body.image !== undefined) o['图片'] = body.image || '';
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/items') {
    if (req.method === 'GET') return json(res, 200, items);
    if (req.method === 'POST') return json(res, 200, { id: 'rec_new' });
    if (req.method === 'PUT') return json(res, 200, { ok: true });
    if (req.method === 'DELETE') return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/expenses') {
    if (req.method === 'GET') return json(res, 200, expenses);
    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      const i = expenses.findIndex(e => e.id === id);
      if (i >= 0) expenses.splice(i, 1);
      return json(res, 200, { ok: true });
    }
    return json(res, 200, { id: 'rec_e1' });
  }
  if (url.pathname === '/api/todos') {
    if (req.method === 'GET') return json(res, 200, todos);
    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      const i = todos.findIndex(t => t.id === id);
      if (i >= 0) todos.splice(i, 1);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST') {
      const id = 'rec_t' + (++seq);
      todos.push(Object.assign({ id, title: body.title || '', status: body.status || '待办' }, body));
      return json(res, 200, { id });
    }
    return json(res, 200, { id: 'rec_t1' });
  }
  if (url.pathname === '/api/projects') {
    if (req.method === 'GET') return json(res, 200, projects);
    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      const i = projects.findIndex(p => p.id === id);
      if (i >= 0) projects.splice(i, 1);
      return json(res, 200, { ok: true });
    }
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

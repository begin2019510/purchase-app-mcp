'use strict';
// 采购域：list/get 优先 /api/needs；写按 v1.4.0 分层——
// T0（一句话意图即可）：create/compareOnly、decide、order.transition 正向、order.update、字段更新
// T1（confirm=目标展示名）：delete、cancel、undecided、终态 status 更新、supplier.delete
const { z } = require('zod');
const { register } = require('./util');
const { assertConfirm } = require('../lib/confirm');
const {
  applyFilters, requireField, loadPurchaseRead,
  LEGACY_STATUSES, NEED_STATUSES, ORDER_STATUSES,
} = require('../lib/datamap');

const PHASE = z.number().int().min(0).max(5).nullable().optional();

// purchase.update 写入这些状态 = 终态冻结，需要 T1
const TERMINAL_WRITE = ['已退', '已取消', '已归档'];
// order.transition 进入这些状态 = 清理终态，需要 T1（confirm=父需求名）
const TERMINAL_ORDER_TO = ['已退', '已取消', '已归档'];

const STATUS_DESC = [
  '需求状态：' + NEED_STATUSES.join('/'),
  '或子单状态：' + ORDER_STATUSES.join('/'),
  '（兼容旧词：' + LEGACY_STATUSES.filter(s => !NEED_STATUSES.includes(s) && !ORDER_STATUSES.includes(s)).join('/') + '）',
  '——匹配需求状态、兼容状态或任一子单状态',
].join('；');

const ORDER_FIELDS = ['qty', 'pricePaid', 'installments', 'installmentAmount', 'installmentStart',
  'installmentPaid', 'date', 'note', 'setDate', 'image', 'supplierId'];

async function needForConfirm(api, id) {
  const loaded = await loadPurchaseRead(api);
  const item = loaded.rows.find(r => r.id === id);
  if (!item) throw new Error('采购记录不存在：' + id);
  return { loaded, item };
}

function findParentOfOrder(rows, orderId) {
  for (const r of rows || []) {
    if ((r.orders || []).some(o => o && o.id === orderId)) return r;
  }
  return null;
}

function findSupplierAnywhere(rows, supplierId) {
  for (const r of rows || []) {
    const s = (r.suppliers || []).find(x => x && x.id === supplierId);
    if (s) return { need: r, supplier: s };
  }
  return null;
}

module.exports = function registerPurchase(server, ctx) {
  const { api } = ctx;

  register(server, ctx, 'purchase.list', {
    title: '采购列表',
    description: '列出采购需求（两级模型：需求+供应商+子单）。列表统一按日期倒序（最新在前），limit=N 恒为最新 N 条。status 可用需求状态/子单状态/旧 8 态；日期为毫秒时间戳。返回 needStatus、orders、suppliers 等最新字段。',
    inputSchema: {
      status: z.string().optional().describe(STATUS_DESC),
      category: z.string().optional(),
      projectId: z.string().optional().describe('项目 ID（rec_N）'),
      keyword: z.string().optional(),
      from: z.number().optional().describe('起始日期（毫秒时间戳）'),
      to: z.number().optional().describe('结束日期（毫秒时间戳）'),
      limit: z.number().int().positive().optional().describe('最新 N 条（先倒序再截取）'),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const loaded = await loadPurchaseRead(api);
    const items = applyFilters(loaded.rows, a);
    return {
      total: loaded.rows.length,
      count: items.length,
      source: loaded.source,
      items,
    };
  });

  register(server, ctx, 'purchase.get', {
    title: '采购详情',
    description: '按 ID 获取单条采购需求详情（含 needStatus、全部 orders/suppliers）。',
    inputSchema: { id: z.string().describe('如 rec_123') },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    requireField(a, 'id');
    const loaded = await loadPurchaseRead(api);
    const item = loaded.rows.find(r => r.id === a.id);
    if (!item) throw new Error('采购记录不存在：' + a.id);
    return item;
  });

  register(server, ctx, 'purchase.create', {
    title: '新建采购',
    description: '新增采购。compareOnly=true 走原生需求口 POST /api/needs（对比中、无供应商，适合先立项再比价）；否则走 /api/items 兼容口。quick=true 直接记为已到；status 不传默认待审批（quick 时为已到）。',
    inputSchema: {
      name: z.string().describe('商品名称'),
      platform: z.string().optional().describe('平台，默认拼多多'),
      category: z.string().optional().describe('分类，默认其他'),
      price: z.number().optional().describe('单价'),
      qty: z.number().int().positive().optional().describe('数量，默认 1'),
      status: z.string().optional().describe('状态，默认待审批'),
      date: z.string().optional().describe('日期（ISO 字符串，如 2026-10-22）'),
      note: z.string().optional(),
      evalSummary: z.string().optional().describe('评估摘要'),
      buyReason: z.string().optional().describe('购买理由'),
      budgetRange: z.string().optional().describe('预算区间（items 口）'),
      budgetMin: z.number().optional().describe('预算下限（compareOnly）'),
      budgetMax: z.number().optional().describe('预算上限（compareOnly）'),
      installments: z.number().int().min(0).optional().describe('分期期数'),
      installmentAmount: z.number().optional().describe('每期金额'),
      installmentStart: z.string().optional().describe('分期开始月，如 2026-10'),
      quick: z.boolean().optional().describe('极速（直接已到）'),
      virtual: z.boolean().optional().describe('虚拟商品'),
      projectId: z.string().optional().describe('关联项目 ID'),
      phaseIdx: PHASE.describe('关联阶段 0~5'),
      compareOnly: z.boolean().optional().describe('true=只建对比需求（/api/needs，状态对比中）'),
    },
  }, async (a) => {
    requireField(a, 'name');
    if (a.compareOnly) {
      const body = { name: a.name };
      if (a.category) body.category = a.category;
      if (a.budgetMin !== undefined) body.budgetMin = a.budgetMin;
      if (a.budgetMax !== undefined) body.budgetMax = a.budgetMax;
      if (a.projectId) body.projectId = a.projectId;
      if (a.phaseIdx !== undefined && a.phaseIdx !== null) body.phaseIdx = a.phaseIdx;
      if (a.virtual) body.virtual = true;
      const r = await api.post('/api/needs', body);
      return { ok: true, id: r && r.id, source: 'needs', status: '对比中' };
    }
    const r = await api.post('/api/items', a);
    return { ok: true, id: r && r.id };
  });

  register(server, ctx, 'purchase.update', {
    title: '更新采购',
    description: '更新采购字段或推进状态（状态推进时服务端会联动生成/完成待办、生成分期待办）。status 为终态（' + TERMINAL_WRITE.join('/') + '）时需要 T1：confirm=需求名称。',
    inputSchema: {
      id: z.string().describe('如 rec_123'),
      name: z.string().optional(),
      platform: z.string().optional(),
      category: z.string().optional(),
      price: z.number().optional(),
      qty: z.number().int().positive().optional(),
      status: z.string().optional(),
      date: z.string().optional(),
      setDate: z.boolean().optional().describe('把日期设为当前时间'),
      note: z.string().optional(),
      evalSummary: z.string().optional(),
      buyReason: z.string().optional(),
      budgetRange: z.string().optional(),
      cancelReason: z.string().optional(),
      installments: z.number().int().min(0).optional(),
      installmentAmount: z.number().optional(),
      installmentStart: z.string().optional(),
      installmentPaid: z.number().int().min(0).optional(),
      virtual: z.boolean().optional(),
      projectId: z.string().nullable().optional().describe('传空字符串解除项目关联'),
      phaseIdx: PHASE,
      confirm: z.string().optional().describe('写入终态时必填：需求名称'),
    },
  }, async (a) => {
    requireField(a, 'id');
    if (a.status && TERMINAL_WRITE.includes(a.status)) {
      const { item } = await needForConfirm(api, a.id);
      assertConfirm(a.confirm, item.name,
        '将「' + item.name + '」状态写为 ' + a.status + '（终态，历史账目冻结）');
    }
    await api.put('/api/items', a);
    return { ok: true };
  });

  register(server, ctx, 'purchase.delete', {
    title: '删除采购',
    description: '删除采购需求并清理联动待办。T1 高危：confirm 必须等于需求名称；执行前请向用户展示一行预览。',
    inputSchema: {
      id: z.string(),
      confirm: z.string().optional().describe('必须等于该采购的需求名称'),
    },
    annotations: { destructiveHint: true },
  }, async (a) => {
    requireField(a, 'id');
    const { loaded, item } = await needForConfirm(api, a.id);
    assertConfirm(a.confirm, item.name,
      '删除采购「' + item.name + '」（' + item.id + '，级联供应商/子单与联动待办，不可恢复）');
    if (loaded.source === 'needs') {
      await api.del('/api/needs/' + encodeURIComponent(a.id));
    } else {
      await api.del('/api/items?id=' + encodeURIComponent(a.id));
    }
    return { ok: true };
  });

  register(server, ctx, 'purchase.decide', {
    title: '采购定点',
    description: '把某供应商定点为正式供应商（POST /api/needs/:id/decide）。mode=new 新建/复用正式单；promote=试用单转正。首轮定点服务端默认淘汰其他落选者。T0：一句话说明定点谁即可。',
    inputSchema: {
      needId: z.string().describe('需求 ID'),
      supplierId: z.string().describe('定点供应商 ID'),
      mode: z.enum(['new', 'promote']).optional().describe('默认 new'),
      pricePaid: z.number().optional().describe('实付单价'),
      qty: z.number().int().positive().optional(),
      installments: z.number().int().min(0).optional(),
      installmentAmount: z.number().optional(),
      installmentStart: z.string().optional(),
      installmentPaid: z.number().int().min(0).optional(),
      date: z.string().optional(),
      note: z.string().optional(),
    },
  }, async (a) => {
    requireField(a, 'needId');
    requireField(a, 'supplierId');
    const body = { supplierId: a.supplierId, mode: a.mode || 'new' };
    for (const k of ['pricePaid', 'qty', 'installments', 'installmentAmount', 'installmentStart', 'installmentPaid', 'date', 'note']) {
      if (a[k] !== undefined) body[k] = a[k];
    }
    const r = await api.post('/api/needs/' + encodeURIComponent(a.needId) + '/decide', body);
    return { ok: true, ...(r && typeof r === 'object' ? r : {}) };
  });

  register(server, ctx, 'purchase.undecided', {
    title: '回退定点',
    description: '回退定点（仅能回退未下单的正式单）。T1 高危：confirm=需求名称；多定点时需指定 supplierId。',
    inputSchema: {
      id: z.string().describe('需求 ID'),
      supplierId: z.string().optional().describe('多定点时指定要回退的供应商'),
      confirm: z.string().optional().describe('必须等于该采购的需求名称'),
    },
    annotations: { destructiveHint: true },
  }, async (a) => {
    requireField(a, 'id');
    const { item } = await needForConfirm(api, a.id);
    assertConfirm(a.confirm, item.name,
      '回退定点「' + item.name + '」（仅移除未下单正式单，需求回到对比中）');
    const body = {};
    if (a.supplierId) body.supplierId = a.supplierId;
    const r = await api.post('/api/needs/' + encodeURIComponent(a.id) + '/undecided', body);
    return { ok: true, ...(r && typeof r === 'object' ? r : {}) };
  });

  register(server, ctx, 'purchase.cancel', {
    title: '取消采购',
    description: '取消需求（未入账子单一并取消；已有入账子单会被服务端拒绝）。T1 高危：confirm=需求名称。',
    inputSchema: {
      id: z.string().describe('需求 ID'),
      reason: z.string().optional().describe('取消原因'),
      confirm: z.string().optional().describe('必须等于该采购的需求名称'),
    },
    annotations: { destructiveHint: true },
  }, async (a) => {
    requireField(a, 'id');
    const { item } = await needForConfirm(api, a.id);
    assertConfirm(a.confirm, item.name,
      '取消需求「' + item.name + '」（' + item.id + '，未入账子单一并取消，不可轻易恢复）');
    const body = {};
    if (a.reason) body.reason = a.reason;
    const r = await api.post('/api/needs/' + encodeURIComponent(a.id) + '/cancel', body);
    return { ok: true, ...(r && typeof r === 'object' ? r : {}) };
  });

  register(server, ctx, 'supplier.add', {
    title: '添加供应商',
    description: '给需求添加对比供应商（POST /api/needs/:id/suppliers）。可直接写优缺点/备注/报价，T0。',
    inputSchema: {
      needId: z.string().describe('需求 ID'),
      name: z.string().describe('供应商名称'),
      price: z.number().optional().describe('报价'),
      platform: z.string().optional(),
      pros: z.string().optional().describe('优点（可代写）'),
      cons: z.string().optional().describe('缺点（可代写）'),
      note: z.string().optional(),
      scores: z.any().optional().describe('维度打分对象'),
    },
  }, async (a) => {
    requireField(a, 'needId');
    requireField(a, 'name', '供应商名称');
    const body = { name: a.name };
    for (const k of ['price', 'platform', 'pros', 'cons', 'note', 'scores']) {
      if (a[k] !== undefined) body[k] = a[k];
    }
    const r = await api.post('/api/needs/' + encodeURIComponent(a.needId) + '/suppliers', body);
    return { ok: true, id: r && r.id };
  });

  register(server, ctx, 'supplier.update', {
    title: '更新供应商',
    description: '更新供应商字段，尤其是优缺点/备注/打分（定点比价时由 agent 代写）。T0。',
    inputSchema: {
      id: z.string().describe('供应商 ID'),
      name: z.string().optional(),
      price: z.number().nullable().optional(),
      platform: z.string().optional(),
      pros: z.string().optional(),
      cons: z.string().optional(),
      note: z.string().optional(),
      sortOrder: z.number().optional(),
      scores: z.any().optional(),
    },
  }, async (a) => {
    requireField(a, 'id');
    const body = {};
    for (const k of ['name', 'price', 'platform', 'pros', 'cons', 'note', 'sortOrder', 'scores']) {
      if (a[k] !== undefined) body[k] = a[k];
    }
    if (!Object.keys(body).length) throw new Error('没有要更新的字段');
    await api.put('/api/suppliers/' + encodeURIComponent(a.id), body);
    return { ok: true };
  });

  register(server, ctx, 'supplier.delete', {
    title: '删除供应商',
    description: '删除对比供应商（已定点/有入账子单时服务端会拒绝）。T1 高危：confirm=供应商名称。',
    inputSchema: {
      id: z.string().describe('供应商 ID'),
      confirm: z.string().optional().describe('必须等于该供应商名称'),
    },
    annotations: { destructiveHint: true },
  }, async (a) => {
    requireField(a, 'id');
    const loaded = await loadPurchaseRead(api);
    const hit = findSupplierAnywhere(loaded.rows, a.id);
    if (!hit) throw new Error('供应商不存在：' + a.id);
    assertConfirm(a.confirm, hit.supplier.name,
      '删除供应商「' + hit.supplier.name + '」（需求「' + hit.need.name + '」下，不可恢复）');
    await api.del('/api/suppliers/' + encodeURIComponent(a.id));
    return { ok: true };
  });

  register(server, ctx, 'order.transition', {
    title: '子单状态流转',
    description: '子单状态流转（POST /api/orders/:id/transition）。正向（待下单→已下单→已到→已归档等）为 T0；进入终态 ' + TERMINAL_ORDER_TO.join('/') + ' 为 T1：confirm=父需求名称。',
    inputSchema: {
      id: z.string().describe('子单 ID'),
      to: z.enum(['待下单', '已下单', '已到', '已退', '已归档', '已取消']).describe('目标状态'),
      note: z.string().optional(),
      confirm: z.string().optional().describe('目标为终态时必填：父需求名称'),
    },
  }, async (a) => {
    requireField(a, 'id');
    requireField(a, 'to');
    if (TERMINAL_ORDER_TO.includes(a.to)) {
      const loaded = await loadPurchaseRead(api);
      const parent = findParentOfOrder(loaded.rows, a.id);
      if (!parent) throw new Error('找不到子单所属需求：' + a.id);
      assertConfirm(a.confirm, parent.name,
        '子单 ' + a.id + ' → ' + a.to + '（所属需求「' + parent.name + '」，终态清理）');
    }
    const body = { to: a.to };
    if (a.note !== undefined) body.note = a.note;
    await api.post('/api/orders/' + encodeURIComponent(a.id) + '/transition', body);
    return { ok: true, id: a.id, to: a.to };
  });

  register(server, ctx, 'order.update', {
    title: '更新子单',
    description: '更新子单字段（数量/实付/分期/备注/日期等；服务端限制：已归档/已取消不可改，已退只可改备注图片）。T0。',
    inputSchema: {
      id: z.string().describe('子单 ID'),
      qty: z.number().int().positive().optional(),
      pricePaid: z.number().optional(),
      installments: z.number().int().min(0).optional(),
      installmentAmount: z.number().optional(),
      installmentStart: z.string().optional(),
      installmentPaid: z.number().int().min(0).optional(),
      date: z.string().optional(),
      note: z.string().optional(),
      setDate: z.boolean().optional(),
      image: z.string().optional(),
      supplierId: z.string().nullable().optional(),
    },
  }, async (a) => {
    requireField(a, 'id');
    const body = {};
    for (const k of ORDER_FIELDS) {
      if (a[k] !== undefined) body[k] = a[k];
    }
    if (!Object.keys(body).length) throw new Error('没有要更新的字段');
    await api.put('/api/orders/' + encodeURIComponent(a.id), body);
    return { ok: true };
  });
};

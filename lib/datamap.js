'use strict';
// 读接口返回中文字典键 → 统一英文键（写接口本来就是英文字段名）。
// 目的：agent 读写用同一套英文 key，避免中文键在 schema/参数里来回映射出错。
// 采购读路径优先 /api/needs（两级模型）；旧部署回退 /api/items（兼容合成行）。

function toNumOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 旧 8 状态（兼容词表；需求状态是 对比中/已定点/已完成/已取消）
const LEGACY_STATUSES = ['待评估', '待审批', '已审批', '已下单', '已到', '已退', '已归档', '已取消'];
const NEED_STATUSES = ['对比中', '已定点', '已完成', '已取消'];
const ORDER_STATUSES = ['待下单', '已下单', '已到', '已退', '已归档', '已取消'];

function mapPurchase(r) {
  return {
    id: r.id,
    name: r['商品名称'] || '',
    platform: r['平台'] || '',
    price: Number(r['单价']) || 0,
    qty: Number(r['数量']) || 1,
    status: r['状态'] || '待审批',
    category: r['分类'] || '其他',
    date: toNumOrNull(r['日期']),
    note: r['备注'] || '',
    createdAt: r['创建时间'] || '',
    approvedAt: r['审批时间'] || '',
    orderedAt: r['下单时间'] || '',
    arrivedAt: r['到货时间'] || '',
    archivedAt: r['归档时间'] || '',
    evalSummary: r['评估摘要'] || '',
    recommendation: r['评估摘要'] || '',
    recommendSupplierId: r['推荐供应商ID'] || '',
    buyReason: r['购买理由'] || '',
    budgetRange: r['预算区间'] || '',
    cancelReason: r['取消原因'] || '',
    image: r['图片'] || '',
    attachments: r['附件'] || {},
    installments: Number(r['分期期数']) || 0,
    installmentAmount: Number(r['分期金额']) || 0,
    installmentStart: r['分期开始月'] || '',
    installmentPaid: Number(r['分期已还']) || 0,
    quick: r['极速'] === '1',
    virtual: r['虚拟'] === '1',
    projectId: r['项目ID'] || '',
    phaseIdx: r['阶段'] === null || r['阶段'] === undefined ? null : Number(r['阶段']),
    // 标记来源：兼容合成行（/api/items），非两级模型原生
    source: 'items',
  };
}

function mapSupplier(s) {
  return {
    id: s.id,
    needId: s.needId || '',
    name: s['谁'] || '',
    platform: s['平台'] || '',
    price: toNumOrNull(s['报价']),
    image: s['图片'] || '',
    pros: s['优点'] || '',
    cons: s['缺点'] || '',
    note: s['备注'] || '',
    scores: (s['打分'] && typeof s['打分'] === 'object') ? s['打分'] : {},
    sort: Number(s['排序']) || 0,
  };
}

function mapOrder(o) {
  return {
    id: o.id,
    needId: o.needId || '',
    supplierId: o.supplierId || '',
    role: o.role || 'formal',
    qty: Number(o['数量']) || 1,
    paid: Number(o['实付']) || 0,
    status: o['状态'] || '待下单',
    installments: Number(o['分期期数']) || 0,
    installmentAmount: o['分期金额'] == null ? 0 : Number(o['分期金额']),
    installmentStart: o['分期开始月'] || '',
    installmentPaid: Number(o['分期已还']) || 0,
    date: toNumOrNull(o['日期']),
    image: o['图片'] || '',
    note: o['备注'] || '',
    quick: o['极速'] === '1',
    createdAt: o['创建时间'] || '',
    approvedAt: o['审批时间'] || '',
    orderedAt: o['下单时间'] || '',
    arrivedAt: o['到货时间'] || '',
    archivedAt: o['归档时间'] || '',
  };
}

// 与服务端 orderToLegacyStatus 同口径：无正式单→待评估；待下单→待审批；否则子单状态
function legacyStatusOf(orders) {
  const formal = (orders || []).find(o => o && o.role === 'formal');
  if (!formal) return '待评估';
  if (formal.status === '待下单') return '待审批';
  return formal.status || '待审批';
}

// /api/needs 一行 → agent 用英文键（need 级状态 + 全量子单/供应商）
function mapNeed(n) {
  const orders = Array.isArray(n.orders) ? n.orders.map(mapOrder) : [];
  const suppliers = Array.isArray(n.suppliers) ? n.suppliers.map(mapSupplier) : [];
  const formal = orders.find(o => o.role === 'formal') || null;
  const pinned = Array.isArray(n['定点供应商IDs']) && n['定点供应商IDs'].length
    ? n['定点供应商IDs']
    : (n['定点供应商ID'] ? [n['定点供应商ID']] : []);
  const bmin = toNumOrNull(n['预算下限']);
  const bmax = toNumOrNull(n['预算上限']);
  // 展示层价格/数量：优先正式单实付；无子单回落主供应商报价（对比中）
  const mainSup = (pinned[0] && suppliers.find(s => s.id === pinned[0])) || suppliers[0] || null;
  const price = formal ? formal.paid : (mainSup && mainSup.price != null ? mainSup.price : 0);
  const qty = formal ? formal.qty : 1;
  // 主状态 = 需求状态（与 App 列表一致）；兼容词表单独给 legacyStatus
  const status = n['状态'] || '对比中';
  return {
    id: n.id,
    name: n['名称'] || '',
    category: n['分类'] || '其他',
    status,
    needStatus: status,
    // 兼容旧 status 筛选（待评估/待审批/已到…）；勿当作需求状态用
    legacyStatus: legacyStatusOf(orders),
    // 正式单执行状态（无正式单为 null）
    orderStatus: formal ? formal.status : null,
    price,
    qty,
    // 有正式单时的平台；否则取主供应商
    platform: (formal && suppliers.find(s => s.id === formal.supplierId)?.platform)
      || (mainSup && mainSup.platform) || '',
    date: formal ? formal.date : null,
    note: formal ? formal.note : '',
    budgetMin: bmin,
    budgetMax: bmax,
    budgetRange: (bmin == null && bmax == null) ? ''
      : (bmin != null && bmax != null ? (bmin === bmax ? String(bmin) : bmin + '-' + bmax)
        : String(bmin != null ? bmin : bmax)),
    cancelReason: n['取消原因'] || '',
    decidedAt: n['定点时间'] || '',
    createdAt: n['创建时间'] || '',
    // 综合推荐：对比结论（服务端 eval_summary + recommend_supplier_id）
    recommendation: n['综合推荐'] || '',
    recommendSupplierId: n['推荐供应商ID'] || '',
    evalSummary: n['综合推荐'] || '',
    quick: n['极速'] === '1',
    virtual: n['虚拟'] === '1',
    projectId: n['项目ID'] || '',
    phaseIdx: n['阶段'] === null || n['阶段'] === undefined || n['阶段'] === '' ? null : Number(n['阶段']),
    pinnedSupplierIds: pinned,
    supplierCount: suppliers.length,
    orderCount: orders.length,
    formalCount: orders.filter(o => o.role === 'formal').length,
    // 摊到旧字段，便于与 mapPurchase 混用（analytics 回退/兼容）
    installments: formal ? formal.installments : 0,
    installmentAmount: formal ? formal.installmentAmount : 0,
    installmentStart: formal ? formal.installmentStart : '',
    installmentPaid: formal ? formal.installmentPaid : 0,
    image: formal ? formal.image : (mainSup && mainSup.image) || '',
    suppliers,
    orders,
    source: 'needs',
  };
}

// needs → 旧 item 形态行（全部子单，调用方按 ACTIVE_BUY 过滤）——与 App orderRows 同口径
function needsToOrderRows(needs) {
  const out = [];
  for (const n of needs || []) {
    const m = mapNeed(n);
    const supMap = {};
    for (const s of m.suppliers) supMap[s.id] = s;
    for (const o of m.orders) {
      const s = supMap[o.supplierId];
      out.push({
        id: o.id,
        _needId: m.id,
        _role: o.role,
        name: m.name,
        category: m.category,
        platform: (s && (s.platform || s.name)) || '',
        price: o.paid,
        qty: o.qty,
        status: o.status,
        date: o.date,
        note: o.note,
        image: o.image,
        installments: o.installments,
        installmentAmount: o.installmentAmount,
        installmentStart: o.installmentStart,
        installmentPaid: o.installmentPaid,
        quick: o.quick || m.quick,
        virtual: m.virtual,
        projectId: m.projectId,
        phaseIdx: m.phaseIdx,
        createdAt: o.createdAt || m.createdAt,
        source: 'needs',
      });
    }
  }
  return out;
}

function mapExpense(r) {
  return {
    id: r.id,
    date: r['日期'] || '',
    type: r['类型'] || '支出',
    category: r['分类'] || '其他',
    amount: Number(r['金额']) || 0,
    note: r['备注'] || '',
    splitWeeks: Number(r['分摊周数']) || 0,
    splitStartWeek: r['分摊开始周'] || '',
    image: r['图片'] || '',
    projectId: r['项目ID'] || '',
    phaseIdx: r['阶段'] === null || r['阶段'] === undefined ? null : Number(r['阶段']),
  };
}

// 状态筛选：need 状态 / 兼容 legacy 状态 / 任一子单状态 命中即保留
function matchStatus(r, status) {
  if (!status) return true;
  if (r.status === status) return true;
  if (r.needStatus === status) return true;
  if (r.legacyStatus === status) return true;
  if (r.orderStatus === status) return true;
  if (Array.isArray(r.orders) && r.orders.some(o => o && o.status === status)) return true;
  return false;
}

// 行的有效时间（排序用）：date（毫秒或可解析字符串）→ createdAt 兜底 → 0
// needs 无正式子单时 date 为 null，靠 createdAt 参与排序，避免被顶到最旧
function effectiveDate(r) {
  const d = r && r.date;
  if (typeof d === 'number' && Number.isFinite(d)) return d;
  if (typeof d === 'string' && d) {
    const t = Date.parse(d);
    if (Number.isFinite(t)) return t;
  }
  const c = r && r.createdAt;
  if (typeof c === 'number' && Number.isFinite(c)) return c;
  if (typeof c === 'string' && c) {
    const t = Date.parse(c.includes('T') ? c : c.replace(' ', 'T'));
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

// rec_N 尾部序号（无则 0）：同时间戳时用作新旧决胜（同日多笔取序号大者）
function idSerial(r) {
  const m = /(\d+)$/.exec(String((r && r.id) || ''));
  return m ? Number(m[1]) : 0;
}

// 统一「最新在前」，不依赖服务端返回方向：
// 主键 effectiveDate 倒序 → id 序号倒序 → 原顺序（稳定排序）
function sortNewestFirst(rows) {
  return rows
    .map((r, i) => ({ r, i, t: effectiveDate(r), n: idSerial(r) }))
    .sort((a, b) => (b.t - a.t) || (b.n - a.n) || (a.i - b.i))
    .map(x => x.r);
}

// 轻量筛选：keyword 模糊匹配、日期区间（毫秒）、项目/状态/分类精确匹配。
// 输出统一按日期倒序；limit=N 恒表示「最新 N 条」。
// 背景：/api/needs 是 id DESC（新→旧）、/api/expenses 是 id ASC（旧→新），
// 旧逻辑 slice(-limit) 在 needs 下会截成最旧的一段。
function applyFilters(rows, { keyword, from, to, status, category, type, projectId, limit } = {}) {
  let out = rows;
  if (status) out = out.filter(r => matchStatus(r, status));
  if (category) out = out.filter(r => r.category === category);
  if (type) out = out.filter(r => r.type === type);
  if (projectId) out = out.filter(r => r.projectId === projectId);
  if (from !== undefined && from !== null) out = out.filter(r => (typeof r.date === 'number' ? r.date : Date.parse(r.date || '') || 0) >= from);
  if (to !== undefined && to !== null) out = out.filter(r => (typeof r.date === 'number' ? r.date : Date.parse(r.date || '') || 0) <= to);
  if (keyword) {
    const k = String(keyword).toLowerCase();
    out = out.filter(r => JSON.stringify(r).toLowerCase().includes(k));
  }
  out = sortNewestFirst(out);
  if (limit && Number(limit) > 0) out = out.slice(0, Number(limit));
  return out;
}

function requireField(obj, field, label) {
  if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
    throw new Error('缺少必填参数：' + (label || field));
  }
}

// 端点缺失（旧 server / SPA HTML 回退）→ 可回退 /api/items
function isEndpointMissing(e) {
  if (!e) return false;
  const st = e.status;
  if (st === 404 || st === 405 || st === 501 || st === 502) return true;
  const msg = String(e.message || '');
  return /返回了网页而不是 JSON/.test(msg) || /Cannot GET/i.test(msg);
}

// 优先 /api/needs；旧部署回退 /api/items（mapPurchase）。返回 { source, rows, needs? }
async function loadPurchaseRead(api) {
  try {
    const needs = await api.get('/api/needs');
    if (Array.isArray(needs)) {
      return { source: 'needs', needs, rows: needs.map(mapNeed) };
    }
    // 非数组 JSON：不当成功，落到 items 回退
  } catch (e) {
    if (!isEndpointMissing(e)) throw e;
  }
  const items = await api.get('/api/items');
  const list = Array.isArray(items) ? items : [];
  return { source: 'items', needs: null, rows: list.map(mapPurchase) };
}

// 统计用：needs → 子单行；items 回退 → 直接 mapPurchase
async function loadPurchaseForAggregate(api) {
  const loaded = await loadPurchaseRead(api);
  if (loaded.source === 'needs') {
    return { source: loaded.source, rows: needsToOrderRows(loaded.needs) };
  }
  return { source: loaded.source, rows: loaded.rows };
}

module.exports = {
  mapPurchase,
  mapNeed,
  mapOrder,
  mapSupplier,
  mapExpense,
  needsToOrderRows,
  legacyStatusOf,
  matchStatus,
  applyFilters,
  effectiveDate,
  idSerial,
  sortNewestFirst,
  requireField,
  isEndpointMissing,
  loadPurchaseRead,
  loadPurchaseForAggregate,
  LEGACY_STATUSES,
  NEED_STATUSES,
  ORDER_STATUSES,
};

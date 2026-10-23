'use strict';
// 读接口返回中文字典键 → 统一英文键（写接口本来就是英文字段名）。
// 目的：agent 读写用同一套英文 key，避免中文键在 schema/参数里来回映射出错。

function toNumOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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
  };
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

// 轻量筛选：keyword 模糊匹配、日期区间（毫秒）、项目/状态/分类精确匹配
function applyFilters(rows, { keyword, from, to, status, category, type, projectId, limit } = {}) {
  let out = rows;
  if (status) out = out.filter(r => r.status === status);
  if (category) out = out.filter(r => r.category === category);
  if (type) out = out.filter(r => r.type === type);
  if (projectId) out = out.filter(r => r.projectId === projectId);
  if (from !== undefined && from !== null) out = out.filter(r => (typeof r.date === 'number' ? r.date : Date.parse(r.date || '') || 0) >= from);
  if (to !== undefined && to !== null) out = out.filter(r => (typeof r.date === 'number' ? r.date : Date.parse(r.date || '') || 0) <= to);
  if (keyword) {
    const k = String(keyword).toLowerCase();
    out = out.filter(r => JSON.stringify(r).toLowerCase().includes(k));
  }
  if (limit && Number(limit) > 0) out = out.slice(-Number(limit));
  return out;
}

function requireField(obj, field, label) {
  if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
    throw new Error('缺少必填参数：' + (label || field));
  }
}

module.exports = { mapPurchase, mapExpense, applyFilters, requireField };

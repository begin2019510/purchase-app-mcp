'use strict';
// 采购域：purchase.list/get（优先 /api/needs 两级模型，旧部署回退 /api/items）
// create/update/delete 仍走 /api/items 兼容写口：状态机/Todo/分期联动由服务端照旧处理。
const { z } = require('zod');
const { register } = require('./util');
const {
  applyFilters, requireField, loadPurchaseRead,
  LEGACY_STATUSES, NEED_STATUSES, ORDER_STATUSES,
} = require('../lib/datamap');

const PHASE = z.number().int().min(0).max(5).nullable().optional();

const STATUS_DESC = [
  '需求状态：' + NEED_STATUSES.join('/'),
  '或子单状态：' + ORDER_STATUSES.join('/'),
  '（兼容旧词：' + LEGACY_STATUSES.filter(s => !NEED_STATUSES.includes(s) && !ORDER_STATUSES.includes(s)).join('/') + '）',
  '——匹配需求状态、兼容状态或任一子单状态',
].join('；');

module.exports = function registerPurchase(server, ctx) {
  const { api } = ctx;

  register(server, ctx, 'purchase.list', {
    title: '采购列表',
    description: '列出采购需求（两级模型：需求+供应商+子单）。status 可用需求状态/子单状态/旧 8 态；日期为毫秒时间戳；limit 取最近 N 条。返回 needStatus、orders、suppliers 等最新字段。',
    inputSchema: {
      status: z.string().optional().describe(STATUS_DESC),
      category: z.string().optional(),
      projectId: z.string().optional().describe('项目 ID（rec_N）'),
      keyword: z.string().optional(),
      from: z.number().optional().describe('起始日期（毫秒时间戳）'),
      to: z.number().optional().describe('结束日期（毫秒时间戳）'),
      limit: z.number().int().positive().optional(),
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
    description: '新增采购记录。quick=true 直接记为已到；status 不传则默认待审批（quick 时为已到）。',
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
      budgetRange: z.string().optional().describe('预算区间'),
      installments: z.number().int().min(0).optional().describe('分期期数'),
      installmentAmount: z.number().optional().describe('每期金额'),
      installmentStart: z.string().optional().describe('分期开始月，如 2026-10'),
      quick: z.boolean().optional().describe('极速（直接已到）'),
      virtual: z.boolean().optional().describe('虚拟商品'),
      projectId: z.string().optional().describe('关联项目 ID'),
      phaseIdx: PHASE.describe('关联阶段 0~5'),
    },
  }, async (a) => {
    requireField(a, 'name');
    const r = await api.post('/api/items', a);
    return { ok: true, id: r && r.id };
  });

  register(server, ctx, 'purchase.update', {
    title: '更新采购',
    description: '更新采购字段或推进状态（状态推进时服务端会联动生成/完成待办、生成分期待办）。',
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
    },
  }, async (a) => {
    requireField(a, 'id');
    await api.put('/api/items', a);
    return { ok: true };
  });

  register(server, ctx, 'purchase.delete', {
    title: '删除采购',
    description: '删除采购记录，并清理其联动待办。',
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true },
  }, async (a) => {
    requireField(a, 'id');
    await api.del('/api/items?id=' + encodeURIComponent(a.id));
    return { ok: true };
  });
};

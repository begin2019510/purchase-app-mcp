'use strict';
// 记账域：expense.list/create/update/delete（经 /api/expenses，金额区间/类型校验照旧）
const { z } = require('zod');
const { register } = require('./util');
const { mapExpense, applyFilters, requireField } = require('../lib/datamap');

const TYPES = ['支出', '收入', '采购'];

module.exports = function registerExpense(server, ctx) {
  const { api } = ctx;

  register(server, ctx, 'expense.list', {
    title: '记账列表',
    description: '列出记账（收支）记录，可按类型/分类/项目/关键词/日期区间筛选。',
    inputSchema: {
      type: z.enum(TYPES).optional(),
      category: z.string().optional(),
      projectId: z.string().optional(),
      keyword: z.string().optional(),
      from: z.number().optional().describe('起始日期（毫秒时间戳）'),
      to: z.number().optional().describe('结束日期（毫秒时间戳）'),
      limit: z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const rows = (await api.get('/api/expenses')).map(mapExpense);
    const items = applyFilters(rows, a);
    return { total: rows.length, count: items.length, items };
  });

  register(server, ctx, 'expense.create', {
    title: '记一笔',
    description: '新增收支记录。金额 0~999999；type 默认支出。',
    inputSchema: {
      amount: z.number().min(0).max(999999),
      type: z.enum(TYPES).optional(),
      category: z.string().optional().describe('分类，默认其他'),
      date: z.string().optional().describe('日期 YYYY-MM-DD，默认今天'),
      note: z.string().optional(),
      splitWeeks: z.number().int().min(0).optional().describe('分摊周数'),
      splitStartWeek: z.string().optional().describe('分摊开始周'),
      projectId: z.string().optional(),
      phaseIdx: z.number().int().min(0).max(5).nullable().optional(),
    },
  }, async (a) => {
    requireField(a, 'amount', '金额');
    const r = await api.post('/api/expenses', a);
    return { ok: true, id: r && r.id };
  });

  register(server, ctx, 'expense.update', {
    title: '更新记账',
    description: '更新记账记录字段。',
    inputSchema: {
      id: z.string(),
      amount: z.number().min(0).max(999999).optional(),
      type: z.enum(TYPES).optional(),
      category: z.string().optional(),
      date: z.string().optional(),
      note: z.string().optional(),
      splitWeeks: z.number().int().min(0).optional(),
      splitStartWeek: z.string().optional(),
      projectId: z.string().nullable().optional(),
      phaseIdx: z.number().int().min(0).max(5).nullable().optional(),
    },
  }, async (a) => {
    requireField(a, 'id');
    await api.put('/api/expenses', a);
    return { ok: true };
  });

  register(server, ctx, 'expense.delete', {
    title: '删除记账',
    description: '删除记账记录。',
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true },
  }, async (a) => {
    requireField(a, 'id');
    await api.del('/api/expenses?id=' + encodeURIComponent(a.id));
    return { ok: true };
  });
};

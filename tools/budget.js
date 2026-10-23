'use strict';
// 预算域：budget.get / budget.save（KV 文档语义，data 为 { 'YYYY-MM': 总额 }）
const { z } = require('zod');
const { register } = require('./util');

module.exports = function registerBudget(server, ctx) {
  const { api } = ctx;

  register(server, ctx, 'budget.get', {
    title: '读取预算',
    description: '读取预算文档（键为 YYYY-MM，值为该月预算总额）。',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const r = await api.get('/api/budgets');
    return { data: (r && r.data) || {} };
  });

  register(server, ctx, 'budget.save', {
    title: '保存预算',
    description: '保存预算。传 data 整体替换；或传 month + total 设置单月预算（会自动与现有数据合并）。',
    inputSchema: {
      data: z.any().optional().describe('完整预算文档，如 {"2026-10": 3000}'),
      month: z.string().optional().describe('YYYY-MM'),
      total: z.number().min(0).optional(),
    },
  }, async (a) => {
    if (a.data !== undefined) {
      await api.post('/api/budgets', { data: a.data });
      return { ok: true, mode: 'replace' };
    }
    if (a.month && a.total !== undefined) {
      if (!/^\d{4}-\d{2}$/.test(a.month)) throw new Error('month 格式应为 YYYY-MM');
      const cur = await api.get('/api/budgets');
      const data = Object.assign({}, (cur && cur.data) || {});
      data[a.month] = a.total;
      await api.post('/api/budgets', { data });
      return { ok: true, mode: 'merge', month: a.month, total: a.total };
    }
    throw new Error('需要 data（整体替换）或 month + total（单月设置）');
  });
};

'use strict';
// 记账域：expense.list/create/update/delete（经 /api/expenses，金额区间/类型校验照旧）
const { z } = require('zod');
const { register } = require('./util');
const { mapExpense, applyFilters, requireField } = require('../lib/datamap');
const { assertConfirm } = require('../lib/confirm');
const { normalizeDateTime, nowBj } = require('../lib/time');

const DATE_DESC = '北京时间，必须带时刻：YYYY-MM-DDTHH:mm（如 2026-11-20T19:30）。禁止只传 YYYY-MM-DD——服务端会存成当天 00:00，时间就被抹掉了。用户说「昨晚7点多」请先用 time.parse 或 time.now。';

const TYPES = ['支出', '收入', '采购'];

module.exports = function registerExpense(server, ctx) {
  const { api } = ctx;

  register(server, ctx, 'expense.list', {
    title: '记账列表',
    description: '列出记账（收支）记录，可按类型/分类/项目/关键词/日期区间筛选。列表统一按日期倒序（最新在前），limit=N 恒为最新 N 条。',
    inputSchema: {
      type: z.enum(TYPES).optional(),
      category: z.string().optional(),
      projectId: z.string().optional(),
      keyword: z.string().optional(),
      from: z.number().optional().describe('起始日期（毫秒时间戳）'),
      to: z.number().optional().describe('结束日期（毫秒时间戳）'),
      limit: z.number().int().positive().optional().describe('最新 N 条（先倒序再截取）'),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const rows = (await api.get('/api/expenses')).map(mapExpense);
    const items = applyFilters(rows, a);
    return { total: rows.length, count: items.length, items };
  });

  register(server, ctx, 'expense.create', {
    title: '记一笔',
    description: '新增收支记录。金额 0~999999；type 默认支出。date 必须带北京时间时刻（YYYY-MM-DDTHH:mm）；不传则记为当前时刻。返回值会回显实际写入的日期时间，请核对。',
    inputSchema: {
      amount: z.number().min(0).max(999999),
      type: z.enum(TYPES).optional(),
      category: z.string().optional().describe('分类，默认其他'),
      date: z.string().optional().describe(DATE_DESC + ' 不传=当前时刻'),
      note: z.string().optional(),
      splitWeeks: z.number().int().min(0).optional().describe('分摊周数'),
      splitStartWeek: z.string().optional().describe('分摊开始周'),
      projectId: z.string().optional(),
      phaseIdx: z.number().int().min(0).max(5).nullable().optional(),
    },
  }, async (a) => {
    requireField(a, 'amount', '金额');
    const date = a.date === undefined || a.date === null || a.date === ''
      ? nowBj().iso
      : normalizeDateTime(a.date, '记账日期').iso;
    const r = await api.post('/api/expenses', { ...a, date });
    return { ok: true, id: r && r.id, date, note: '已按北京时间 ' + date + ' 记账' };
  });

  register(server, ctx, 'expense.update', {
    title: '更新记账',
    description: '更新记账记录字段。',
    inputSchema: {
      id: z.string(),
      amount: z.number().min(0).max(999999).optional(),
      type: z.enum(TYPES).optional(),
      category: z.string().optional(),
      date: z.string().optional().describe(DATE_DESC),
      note: z.string().optional(),
      splitWeeks: z.number().int().min(0).optional(),
      splitStartWeek: z.string().optional(),
      projectId: z.string().nullable().optional(),
      phaseIdx: z.number().int().min(0).max(5).nullable().optional(),
    },
  }, async (a) => {
    requireField(a, 'id');
    const body = { ...a };
    if (body.date !== undefined && body.date !== null && body.date !== '') {
      body.date = normalizeDateTime(body.date, '记账日期').iso;
    }
    await api.put('/api/expenses', body);
    return { ok: true, ...(body.date ? { date: body.date } : {}) };
  });

  register(server, ctx, 'expense.delete', {
    title: '删除记账',
    description: '删除记账记录。T1 高危：confirm=备注（无备注时为 ID）。',
    inputSchema: {
      id: z.string(),
      confirm: z.string().optional().describe('必须等于该记账的备注；无备注时填 ID'),
    },
    annotations: { destructiveHint: true },
  }, async (a) => {
    requireField(a, 'id');
    const rows = await api.get('/api/expenses');
    const row = (Array.isArray(rows) ? rows : []).find(r => r && r.id === a.id);
    if (!row) throw new Error('记账记录不存在：' + a.id);
    const label = String(row['备注'] || '').trim() || a.id;
    assertConfirm(a.confirm, label,
      '删除记账 ' + a.id + '（' + (row['类型'] || '') + ' ' + (row['金额'] != null ? row['金额'] : '') +
      '，备注「' + label + '」，不可恢复）');
    await api.del('/api/expenses?id=' + encodeURIComponent(a.id));
    return { ok: true };
  });
};

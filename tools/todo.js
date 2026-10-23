'use strict';
// 待办域：todo.list/create/update/delete（重复待办完成自动续期、软删/硬删按服务端规则）
const { z } = require('zod');
const { register } = require('./util');
const { requireField } = require('../lib/datamap');

function filter(rows, { status, category, priority, projectId, keyword, limit } = {}) {
  let out = rows;
  if (status) out = out.filter(r => r.status === status);
  if (category) out = out.filter(r => r.category === category);
  if (priority) out = out.filter(r => r.priority === priority);
  if (projectId) out = out.filter(r => r.projectId === projectId);
  if (keyword) {
    const k = String(keyword).toLowerCase();
    out = out.filter(r => JSON.stringify(r).toLowerCase().includes(k));
  }
  if (limit && Number(limit) > 0) out = out.slice(-Number(limit));
  return out;
}

module.exports = function registerTodo(server, ctx) {
  const { api } = ctx;

  register(server, ctx, 'todo.list', {
    title: '待办列表',
    description: '列出待办，可按状态/分类/优先级/项目/关键词筛选。',
    inputSchema: {
      status: z.string().optional().describe('待办/进行中/已完成/已删除'),
      category: z.string().optional(),
      priority: z.string().optional().describe('高/中/低'),
      projectId: z.string().optional(),
      keyword: z.string().optional(),
      limit: z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const rows = await api.get('/api/todos');
    const items = filter(rows, a);
    return { total: rows.length, count: items.length, items };
  });

  register(server, ctx, 'todo.create', {
    title: '新建待办',
    description: '新增待办。repeat 为每天/每周/每月时，完成后服务端自动生成下一条。',
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      dueDate: z.string().optional().describe('截止日期 ISO 字符串'),
      priority: z.string().optional().describe('高/中/低，默认中'),
      category: z.string().optional(),
      status: z.string().optional().describe('默认待办'),
      repeat: z.string().optional().describe('无/每天/每周/每月'),
      subtasks: z.string().optional().describe('子任务 JSON 字符串'),
      projectId: z.string().optional(),
      tags: z.string().optional().describe('标签 JSON 字符串'),
      linkType: z.string().optional(),
      linkId: z.string().optional(),
      order: z.number().optional(),
    },
  }, async (a) => {
    requireField(a, 'title');
    const r = await api.post('/api/todos', a);
    return { ok: true, id: r && r.id };
  });

  register(server, ctx, 'todo.update', {
    title: '更新待办',
    description: '更新待办字段；status=已完成 且 repeat 非无 时自动续期下一条。',
    inputSchema: {
      id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      dueDate: z.string().optional(),
      priority: z.string().optional(),
      category: z.string().optional(),
      status: z.string().optional(),
      repeat: z.string().optional(),
      subtasks: z.string().optional(),
      projectId: z.string().nullable().optional(),
      tags: z.string().optional(),
      linkType: z.string().optional(),
      linkId: z.string().optional(),
      order: z.number().optional(),
      reminders: z.string().optional(),
    },
  }, async (a) => {
    requireField(a, 'id');
    const r = await api.put('/api/todos', a);
    return { ok: true, renewed: !!(r && r.renewed) };
  });

  register(server, ctx, 'todo.delete', {
    title: '删除待办',
    description: '默认软删（状态置已删除）；purge=true 彻底删除。',
    inputSchema: { id: z.string(), purge: z.boolean().optional() },
    annotations: { destructiveHint: true },
  }, async (a) => {
    requireField(a, 'id');
    await api.del('/api/todos?id=' + encodeURIComponent(a.id) + (a.purge ? '&action=purge' : ''));
    return { ok: true, purged: !!a.purge };
  });
};

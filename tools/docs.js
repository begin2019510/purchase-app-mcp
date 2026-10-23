'use strict';
// 重复项 / 分类域：recurring.*、cats.*（KV 文档；update 支持整体替换或浅合并）
const { z } = require('zod');
const { register } = require('./util');

async function updateDoc(api, path, a, empty) {
  if (a.data !== undefined) {
    await api.post(path, { data: a.data });
    return { ok: true, mode: 'replace' };
  }
  if (a.patch !== undefined) {
    const cur = await api.get(path);
    const merged = Object.assign({}, (cur && cur.data) || empty, a.patch);
    await api.post(path, { data: merged });
    return { ok: true, mode: 'merge' };
  }
  throw new Error('需要 data（整体替换）或 patch（浅合并）');
}

module.exports = function registerDocs(server, ctx) {
  const { api } = ctx;

  register(server, ctx, 'recurring.list', {
    title: '重复项列表',
    description: '读取重复收支/固定项文档。',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const r = await api.get('/api/recurring');
    return { data: (r && r.data) || { items: [] } };
  });

  register(server, ctx, 'recurring.update', {
    title: '更新重复项',
    description: '保存重复项。data 整体替换；patch 与现有文档浅合并（如 {items: [...]}）。',
    inputSchema: { data: z.any().optional(), patch: z.any().optional() },
  }, async (a) => updateDoc(api, '/api/recurring', a, { items: [] }));

  register(server, ctx, 'cats.list', {
    title: '分类列表',
    description: '读取自定义分类文档。',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const r = await api.get('/api/cats');
    return { data: (r && r.data) || { list: [] } };
  });

  register(server, ctx, 'cats.update', {
    title: '更新分类',
    description: '保存分类。data 整体替换；patch 与现有文档浅合并（如 {list: [...]}）。',
    inputSchema: { data: z.any().optional(), patch: z.any().optional() },
  }, async (a) => updateDoc(api, '/api/cats', a, { list: [] }));
};

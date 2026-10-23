'use strict';
// 项目/阶段域：project.* + phase.list/phase.status.set（P0~P5 通关制；P5 不可跳过由服务端拒绝）
const { z } = require('zod');
const { register } = require('./util');
const { requireField } = require('../lib/datamap');

function summarize(p) {
  const phases = p.phases || [];
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    dueDate: p.dueDate,
    status: p.status,
    color: p.color,
    budget: p.budget,
    currentPhase: p.currentPhase,
    spend: p.spend ? { buy: Math.round(p.spend.buy), exp: Math.round(p.spend.exp) } : { buy: 0, exp: 0 },
    phases: phases.map(ph => ({ idx: ph.idx, name: ph.name, status: ph.status })),
    phaseDone: phases.filter(ph => ph.status === 'done').length,
    phaseTotal: phases.length,
    itemCount: (p.items || []).length,
  };
}

module.exports = function registerProject(server, ctx) {
  const { api } = ctx;

  async function allProjects() {
    return api.get('/api/projects');
  }

  register(server, ctx, 'project.list', {
    title: '项目列表',
    description: '列出项目。默认返回摘要（含阶段状态与花费合计）；detail=true 返回完整阶段/交付物/流水。',
    inputSchema: {
      status: z.string().optional(),
      detail: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    let rows = await allProjects();
    if (a.status) rows = rows.filter(p => p.status === a.status);
    return { count: rows.length, projects: a.detail ? rows : rows.map(summarize) };
  });

  register(server, ctx, 'project.get', {
    title: '项目详情',
    description: '按 ID 获取项目完整信息（阶段、交付物、花费与流水）。',
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    requireField(a, 'id');
    const rows = await allProjects();
    const p = rows.find(x => x.id === a.id);
    if (!p) throw new Error('项目不存在：' + a.id);
    return p;
  });

  register(server, ctx, 'project.create', {
    title: '新建项目',
    description: '新增项目，服务端自动创建 P0~P5 六个阶段。',
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      dueDate: z.string().optional().describe('ISO 日期字符串'),
      budget: z.number().nullable().optional(),
      color: z.string().optional(),
      status: z.string().optional().describe('进行中/已完成/已归档等'),
    },
  }, async (a) => {
    requireField(a, 'name');
    const r = await api.post('/api/projects', a);
    return { ok: true, id: r && r.id };
  });

  register(server, ctx, 'project.update', {
    title: '更新项目',
    description: '更新项目基本信息或当前阶段指针。',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      dueDate: z.string().optional(),
      status: z.string().optional(),
      color: z.string().optional(),
      budget: z.number().nullable().optional(),
      currentPhase: z.number().int().min(0).max(5).optional(),
    },
  }, async (a) => {
    requireField(a, 'id');
    await api.put('/api/projects', a);
    return { ok: true };
  });

  register(server, ctx, 'project.delete', {
    title: '删除项目',
    description: '删除项目并级联删除阶段/交付物；关联的采购/记账/待办解除关联（不删数据）。',
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true },
  }, async (a) => {
    requireField(a, 'id');
    await api.del('/api/projects?id=' + encodeURIComponent(a.id));
    return { ok: true };
  });

  register(server, ctx, 'phase.list', {
    title: '阶段列表',
    description: '列出项目阶段（不传 projectId 则返回全部项目的阶段）。',
    inputSchema: { projectId: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    let rows = await allProjects();
    if (a.projectId) rows = rows.filter(p => p.id === a.projectId);
    const phases = [];
    for (const p of rows) {
      for (const ph of p.phases || []) {
        phases.push({ projectId: p.id, projectName: p.name, ...ph });
      }
    }
    return { count: phases.length, phases };
  });

  register(server, ctx, 'phase.status.set', {
    title: '设置阶段状态',
    description: '设置阶段状态（todo/doing/done/skipped）。P5 为最终阶段，不能 skipped；P5 done 时项目自动通关。',
    inputSchema: {
      projectId: z.string(),
      phaseIdx: z.number().int().min(0).max(5),
      status: z.enum(['todo', 'doing', 'done', 'skipped']),
      note: z.string().optional(),
      displayName: z.string().optional(),
    },
  }, async (a) => {
    requireField(a, 'projectId');
    await api.put('/api/phases', a);
    return { ok: true };
  });
};

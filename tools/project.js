'use strict';
// 项目/阶段域：project.* + phase.list/phase.status.set（P0~P5 通关制；P5 不可跳过由服务端拒绝）
const { z } = require('zod');
const { register } = require('./util');
const { requireField } = require('../lib/datamap');
const { assertConfirm } = require('../lib/confirm');

function summarize(p) {
  const phases = p.phases || [];
  const isTrack = p.projectType === 'track';
  const cfg = p.trackConfig || {};
  const ts = p.trackStats || null;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    dueDate: p.dueDate,
    status: p.status,
    color: p.color,
    budget: p.budget,
    currentPhase: p.currentPhase,
    projectType: isTrack ? 'track' : 'plan',
    spend: p.spend ? { buy: Math.round(p.spend.buy), exp: Math.round(p.spend.exp) } : { buy: 0, exp: 0 },
    ...(isTrack ? {
      goal: (cfg.goal && cfg.goal.text) || '',
      startDate: cfg.startDate || '',
      targetDate: cfg.targetDate || '',
      closed: cfg.closed || null,
      recordCount: p.recordCount || 0,
      weekCount: p.weekCount || 0,
      ...(ts ? {
        goalPct: ts.goal ? ts.goal.pct : null,
        goalAchieved: ts.goal ? ts.goal.achieved : false,
        weekMet: ts.week ? ts.week.met : false,
        streak: ts.streak,
        nextMilestone: ts.nextMilestone ? ts.nextMilestone.name : '',
        milestoneDone: ts.milestoneDone,
        milestoneTotal: ts.milestoneTotal,
      } : {}),
    } : {
      phases: phases.map(ph => ({ idx: ph.idx, name: ph.name, status: ph.status })),
      phaseDone: phases.filter(ph => ph.status === 'done').length,
      phaseTotal: phases.length,
      itemCount: (p.items || []).length,
    }),
  };
}

function isTrack(p) { return p.projectType === 'track'; }

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
    description: [
      '新增项目。两种类型：',
      '① plan（默认）= 阶段计划项目，服务端自动创建 P0~P5 六个阶段；可用 steps 一次拆成最多 6 步（第一步→P0，最后一步→P5）。',
      '② track = 长期跟踪项目（如减肥/读书/习惯打卡），没有阶段；必须提供 trackFields（记录字段）与 trackConfig.goal.text（项目目标），记录用 tracker.record.create 写。',
    ].join('\n'),
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      dueDate: z.string().optional().describe('截止日期 YYYY-MM-DD（只到天）'),
      budget: z.number().nullable().optional(),
      color: z.string().optional().describe('如 #6366f1'),
      status: z.string().optional().describe('进行中/已完成/已归档等；track 项目请用 tracker.close'),
      projectType: z.enum(['plan', 'track']).optional().describe('项目类型，默认 plan'),
      steps: z.array(z.union([
        z.string(),
        z.object({
          name: z.string().describe('步骤名称'),
          budget: z.number().optional().describe('该步预算'),
          plannedDays: z.number().optional().describe('计划天数（1~30）'),
        }),
      ])).max(6).optional().describe('plan 项目的步骤规划，最多 6 步；传了就会写入对应阶段，不传则 6 个阶段全部待规划'),
      trackFields: z.array(z.object({
        key: z.string().describe('英文小写键名，如 weight'),
        name: z.string().describe('显示名，如 体重'),
        type: z.enum(['text', 'longtext', 'number', 'date', 'select', 'checkbox']).optional().describe('默认 text'),
        options: z.array(z.string()).optional().describe('select 的选项'),
        unit: z.string().optional().describe('number 的单位，如 kg'),
        required: z.boolean().optional(),
      })).optional().describe('track 项目必填：记录字段定义（1~24 个）'),
      trackConfig: z.object({
        goal: z.object({
          text: z.string().describe('项目目标（track 必填），如「3 个月减到 70kg」'),
          kind: z.enum(['number', 'milestone', 'none']).optional(),
          metric: z.object({
            agg: z.enum(['count', 'countValue', 'countTrue', 'sum', 'latest', 'max']).optional(),
            field: z.string().optional(),
            value: z.string().optional(),
          }).optional(),
          target: z.number().nullable().optional(),
          unit: z.string().optional(),
          direction: z.enum(['up', 'down']).optional(),
          baseline: z.number().nullable().optional(),
        }),
        startDate: z.string().optional().describe('YYYY-MM-DD，默认今天'),
        targetDate: z.string().optional().describe('YYYY-MM-DD'),
        week: z.object({
          target: z.number().optional().describe('每周目标次数/数量'),
          unit: z.string().optional(),
          metric: z.any().optional(),
        }).optional(),
        milestones: z.array(z.object({
          name: z.string(),
          id: z.string().optional(),
          targetDate: z.string().optional(),
          targetValue: z.number().nullable().optional(),
          done: z.boolean().optional(),
        })).optional(),
        dateField: z.string().optional().describe('哪个字段是记录日期（默认第一个 date 字段）'),
        titleField: z.string().optional().describe('哪个字段是标题'),
        kanbanField: z.string().optional().describe('看板按哪个 select 字段分组'),
        template: z.enum(['job', 'fitness', 'reading', 'study', 'habit', 'custom']).optional(),
      }).optional().describe('track 项目的目标/周目标/里程碑配置；goal.text 必填'),
    },
  }, async (a) => {
    requireField(a, 'name');
    const body = { ...a };
    if (body.projectType === 'track') {
      if (!Array.isArray(body.trackFields) || !body.trackFields.length) {
        throw new Error('track 项目必须提供 trackFields（至少一个记录字段，如 date/text/number）');
      }
      if (!body.trackConfig || !body.trackConfig.goal || !String(body.trackConfig.goal.text || '').trim()) {
        throw new Error('track 项目必须提供 trackConfig.goal.text（项目目标）');
      }
    }
    const r = await api.post('/api/projects', body);
    return {
      ok: true,
      id: r && r.id,
      projectType: body.projectType === 'track' ? 'track' : 'plan',
      steps: Array.isArray(body.steps) ? body.steps.length : 0,
    };
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
    description: '删除项目并级联删除阶段/交付物；关联的采购/记账/待办解除关联（不删数据）。T1 高危：confirm=项目名称。',
    inputSchema: {
      id: z.string(),
      confirm: z.string().optional().describe('必须等于该项目名称'),
    },
    annotations: { destructiveHint: true },
  }, async (a) => {
    requireField(a, 'id');
    const rows = await allProjects();
    const p = (Array.isArray(rows) ? rows : []).find(x => x && x.id === a.id);
    if (!p) throw new Error('项目不存在：' + a.id);
    assertConfirm(a.confirm, p.name,
      '删除项目「' + p.name + '」（' + a.id + '，级联删阶段/交付物，关联数据解除关联，不可恢复）');
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

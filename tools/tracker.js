'use strict';
// 跟踪项目域（project_type='track'）：记录 CRUD / 仪表盘 / 字段与目标 / 里程碑 / 结项
// 跟踪项目没有 P0~P5 阶段，记录存 project_records；记录日期只到天（北京时间 YYYY-MM-DD）。
const { z } = require('zod');
const { register } = require('./util');
const { requireField } = require('../lib/datamap');
const { assertConfirm } = require('../lib/confirm');
const { normalizeDateTime } = require('../lib/time');

const DATE_ONLY_DESC = '北京时间日期 YYYY-MM-DD（跟踪记录只到天）。';

async function allProjects(api) {
  const rows = await api.get('/api/projects');
  return Array.isArray(rows) ? rows : [];
}

async function findProject(api, projectId) {
  const rows = await allProjects(api);
  const p = rows.find(x => x && x.id === projectId);
  if (!p) throw new Error('项目不存在：' + projectId);
  if (p.projectType !== 'track') throw new Error('「' + (p.name || projectId) + '」不是跟踪项目（projectType=' + (p.projectType || 'plan') + '）');
  return p;
}

function recordLabel(record, project) {
  const data = (record && record.data) || {};
  const cfg = (project && project.trackConfig) || {};
  const keys = [];
  if (cfg.titleField) keys.push(cfg.titleField);
  for (const f of (project && project.trackFields) || []) {
    if (f.type === 'text' || f.type === 'longtext') keys.push(f.key);
  }
  for (const k of keys) {
    const v = data[k];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return (record && (record.recordDate || record.id)) || '记录';
}

// 记录 ID → { project, record }：跟踪项目数量很少，逐个项目查一遍即可
async function findRecord(api, recordId) {
  for (const p of await allProjects(api)) {
    if (p.projectType !== 'track') continue;
    let recs;
    try {
      recs = await api.get('/api/tracker/records?projectId=' + encodeURIComponent(p.id) + '&limit=1000');
    } catch (e) { continue; }
    const rec = (Array.isArray(recs) ? recs : []).find(r => r && r.id === recordId);
    if (rec) return { project: p, record: rec };
  }
  throw new Error('跟踪记录不存在：' + recordId);
}

module.exports = function registerTracker(server, ctx) {
  const { api } = ctx;

  register(server, ctx, 'tracker.records.list', {
    title: '跟踪记录列表',
    description: '列出跟踪项目的记录（按记录日期倒序）。跟踪项目没有阶段；每条记录 = { id, recordDate, data }，data 的键见项目的 trackFields。',
    inputSchema: {
      projectId: z.string().describe('跟踪项目 ID（rec_N）'),
      limit: z.number().int().positive().optional().describe('最多返回 N 条（默认 500，上限 1000）'),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    requireField(a, 'projectId');
    await findProject(api, a.projectId);
    let url = '/api/tracker/records?projectId=' + encodeURIComponent(a.projectId);
    if (a.limit) url += '&limit=' + encodeURIComponent(a.limit);
    const rows = await api.get(url);
    return { count: Array.isArray(rows) ? rows.length : 0, items: Array.isArray(rows) ? rows : [] };
  });

  register(server, ctx, 'tracker.overview', {
    title: '跟踪项目仪表盘',
    description: '获取跟踪项目的目标进度、本周/本月/累计统计、连续达标周数、里程碑与结项报告。',
    inputSchema: {
      projectId: z.string().describe('跟踪项目 ID（rec_N）'),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    requireField(a, 'projectId');
    await findProject(api, a.projectId);
    return api.get('/api/tracker/overview?projectId=' + encodeURIComponent(a.projectId));
  });

  register(server, ctx, 'tracker.record.create', {
    title: '新增跟踪记录',
    description: '给跟踪项目写一条记录。data 的键必须是该项目 trackFields 里定义过的 key；日期字段用 YYYY-MM-DD。记录归属日期优先取项目配置的 dateField（或第一个日期字段），都没有则记到今天。',
    inputSchema: {
      projectId: z.string().describe('跟踪项目 ID'),
      data: z.record(z.string(), z.any()).describe('记录内容，如 { "date": "2026-11-21", "weight": 71.2, "note": "跑了 3km" }'),
    },
  }, async (a) => {
    requireField(a, 'projectId');
    requireField(a, 'data', '记录内容 data');
    await findProject(api, a.projectId);
    const r = await api.post('/api/tracker/records', { projectId: a.projectId, data: a.data });
    return { ok: true, id: r && r.id, recordDate: r && r.recordDate };
  });

  register(server, ctx, 'tracker.record.update', {
    title: '更新跟踪记录',
    description: '更新一条跟踪记录的 data（整体覆盖该项目记录的 data 字段；未传的字段会被清空，请先读原记录再合并）。',
    inputSchema: {
      id: z.string().describe('记录 ID'),
      data: z.record(z.string(), z.any()).describe('完整的新 data 对象'),
    },
  }, async (a) => {
    requireField(a, 'id');
    requireField(a, 'data', '记录内容 data');
    const r = await api.put('/api/tracker/records', { id: a.id, data: a.data });
    return { ok: true, id: a.id, recordDate: r && r.recordDate };
  });

  register(server, ctx, 'tracker.record.delete', {
    title: '删除跟踪记录',
    description: '真删一条跟踪记录（不可恢复）。T1 高危：confirm 必须等于记录标题；无标题时填记录 ID。执行前请先向用户展示一行预览。',
    inputSchema: {
      id: z.string().describe('记录 ID'),
      confirm: z.string().optional().describe('必须等于记录标题（无标题时为记录 ID）'),
    },
    annotations: { destructiveHint: true },
  }, async (a) => {
    requireField(a, 'id');
    const hit = await findRecord(api, a.id);
    const label = recordLabel(hit.record, hit.project);
    assertConfirm(a.confirm, label,
      '删除跟踪项目「' + (hit.project.name || hit.project.id) + '」下的记录「' + label + '」（' + hit.record.recordDate + '，真删不可恢复）');
    await api.del('/api/tracker/records?id=' + encodeURIComponent(a.id));
    return { ok: true, id: a.id };
  });

  register(server, ctx, 'tracker.fields.update', {
    title: '更新跟踪字段/配置',
    description: '整体保存跟踪项目的字段定义与目标配置（fields 不传则保留现有字段；config 不传则保留现有配置）。保持 goal.text 非空。',
    inputSchema: {
      projectId: z.string().describe('跟踪项目 ID'),
      fields: z.array(z.object({
        key: z.string(),
        name: z.string(),
        type: z.enum(['text', 'longtext', 'number', 'date', 'select', 'checkbox']).optional(),
        options: z.array(z.string()).optional(),
        unit: z.string().optional(),
        required: z.boolean().optional(),
      })).optional().describe('完整字段列表（至少一个）'),
      config: z.any().optional().describe('完整 trackConfig：goal/week/milestones/dateField/titleField/kanbanField 等；goal.text 必填'),
    },
  }, async (a) => {
    requireField(a, 'projectId');
    if (a.fields === undefined && a.config === undefined) {
      throw new Error('fields 与 config 至少要提供一个');
    }
    await findProject(api, a.projectId);
    const body = { projectId: a.projectId };
    if (a.fields !== undefined) body.fields = a.fields;
    if (a.config !== undefined) body.config = a.config;
    const r = await api.put('/api/tracker/fields', body);
    return { ok: true, fields: r && r.fields, config: r && r.config };
  });

  register(server, ctx, 'tracker.milestone.set', {
    title: '勾选里程碑',
    description: '把跟踪项目的某个里程碑标记为完成/未完成（只改这一项，不用回传整份配置）。milestone id 从项目 trackConfig.milestones 里取。',
    inputSchema: {
      projectId: z.string().describe('跟踪项目 ID'),
      id: z.string().describe('里程碑 ID（如 m1）'),
      done: z.boolean().describe('true=完成，false=取消完成'),
      doneDate: z.string().optional().describe(DATE_ONLY_DESC + ' 默认今天'),
    },
  }, async (a) => {
    requireField(a, 'projectId');
    requireField(a, 'id', '里程碑 ID');
    requireField(a, 'done', 'done');
    await findProject(api, a.projectId);
    const body = { projectId: a.projectId, id: a.id, done: a.done };
    if (a.doneDate) body.doneDate = normalizeDateTime(a.doneDate, '里程碑完成日期', { allowDateOnly: true }).date;
    const r = await api.post('/api/tracker/milestone', body);
    return { ok: true, milestones: r && r.milestones };
  });

  register(server, ctx, 'tracker.close', {
    title: '跟踪项目结项',
    description: '结束跟踪项目（状态置已完成并生成结项报告）。T1 高危：confirm 必须等于项目名称；执行前请展示一行预览。',
    inputSchema: {
      projectId: z.string().describe('跟踪项目 ID'),
      result: z.enum(['achieved', 'ended']).optional().describe('achieved=达成目标（默认），ended=提前结束'),
      note: z.string().optional().describe('结项备注/复盘'),
      confirm: z.string().optional().describe('必须等于项目名称'),
    },
    annotations: { destructiveHint: true },
  }, async (a) => {
    requireField(a, 'projectId');
    const p = await findProject(api, a.projectId);
    assertConfirm(a.confirm, p.name,
      '结项跟踪项目「' + p.name + '」（' + p.id + '，状态置已完成，之后记录只读；可用 tracker.reopen 重开）');
    const body = { projectId: a.projectId };
    if (a.result) body.result = a.result;
    if (a.note !== undefined) body.note = a.note;
    const r = await api.post('/api/tracker/close', body);
    return { ok: true, closed: r && r.closed, report: r && r.report };
  });

  register(server, ctx, 'tracker.reopen', {
    title: '重新打开跟踪项目',
    description: '撤销结项：清空结项信息，状态回到进行中，历史记录原样保留。',
    inputSchema: {
      projectId: z.string().describe('跟踪项目 ID'),
    },
  }, async (a) => {
    requireField(a, 'projectId');
    await findProject(api, a.projectId);
    const r = await api.post('/api/tracker/reopen', { projectId: a.projectId });
    return { ok: true, config: r && r.config };
  });
};

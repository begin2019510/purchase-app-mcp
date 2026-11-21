'use strict';
// 时间域：time.now / time.parse
// 目的：agent 记账、建待办、建采购时先把用户口语时间转成北京时间 ISO，再写入；
// 绝不能用纯日期（服务端会按当天 00:00 存，时间就丢了）。
const { z } = require('zod');
const { register } = require('./util');
const { nowBj, parseChinese } = require('../lib/time');

module.exports = function registerTime(server, ctx) {
  register(server, ctx, 'time.now', {
    title: '当前北京时间',
    description: '获取当前北京时间（UTC+8）的 ISO、日期、时刻、星期。写账目/待办/采购前，如果用户说「今天」「刚刚」「现在」，先调用本工具拿到真实时刻，再把 iso 写进 date/dueDate。',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const n = nowBj();
    return {
      ...n,
      rule: '写日期时使用 YYYY-MM-DDTHH:mm（北京时间）。纯日期会被存成 00:00，等于丢掉时间。',
    };
  });

  register(server, ctx, 'time.parse', {
    title: '解析口语时间',
    description: '把中文口语时间解析成北京时间 ISO。支持「昨晚7点多」「昨天晚上七点半」「今天下午3点20」「大前天上午9点」「2026-11-20 19:30」等。返回 iso（YYYY-MM-DDTHH:mm）后，原样写入 expense/purchase/todo 的日期字段。若只说日期没说时刻，iso 为 null 且 needTime=true——此时必须向用户确认具体时间，不要用 00:00 代替。',
    inputSchema: {
      text: z.string().describe('中文时间描述，如「昨天晚上7点多」'),
      now: z.string().optional().describe('可选：以该时间作为「今天」的基准（北京时间 YYYY-MM-DDTHH:mm），默认当前时间'),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    if (!a.text || !String(a.text).trim()) throw new Error('缺少要解析的时间文本');
    let baseMs = undefined;
    if (a.now) {
      const { normalizeDateTime } = require('../lib/time');
      baseMs = normalizeDateTime(a.now, 'now').millis;
    }
    return parseChinese(a.text, baseMs);
  });
};

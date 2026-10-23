'use strict';
// 审计日志参数脱敏：密码/令牌类字段一律打码，超长字符串与图片 data URL 截断
const SECRET_KEY = /pass(word)?|token|secret|authorization|cookie/i;

function maskValue(v) {
  if (typeof v !== 'string') return v;
  if (v.startsWith('data:') && v.length > 120) return `[data-url ${v.length} chars]`;
  return v.length > 500 ? v.slice(0, 120) + `…(${v.length} chars)` : v;
}

function maskArgs(value) {
  if (Array.isArray(value)) return value.map(maskArgs);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) out[k] = '***';
      else if (v && typeof v === 'object') out[k] = maskArgs(v);
      else out[k] = maskValue(v);
    }
    return out;
  }
  return maskValue(value);
}

module.exports = { maskArgs };

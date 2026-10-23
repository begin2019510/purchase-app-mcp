'use strict';
// 工具注册包装：统一本机审计日志（参数脱敏）与中文错误返回
const { maskArgs } = require('../lib/mask');

function textResult(out) {
  if (out === undefined) return { content: [{ type: 'text', text: 'ok' }] };
  const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
  return { content: [{ type: 'text', text }] };
}

function register(server, ctx, name, config, fn) {
  server.registerTool(name, config, async (args) => {
    const startedAt = Date.now();
    const user = ctx.api && ctx.api.identityName ? ctx.api.identityName() : '';
    try {
      const out = await fn(args || {});
      ctx.log({ event: 'tool_call', tool: name, ok: true, ms: Date.now() - startedAt, args: maskArgs(args), user });
      return textResult(out);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      ctx.log({ event: 'tool_call', tool: name, ok: false, ms: Date.now() - startedAt, args: maskArgs(args), error: msg, user });
      return { content: [{ type: 'text', text: '❌ ' + msg }], isError: true };
    }
  });
}

module.exports = { register, textResult };

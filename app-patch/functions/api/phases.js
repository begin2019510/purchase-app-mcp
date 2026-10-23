// App 侧补丁：把公网 /api/phases 转发到内网 purchase-server 的 /api/phases
// 用法：复制到 purchase-app/functions/api/phases.js，随 Cloudflare Pages 部署生效。
// 模式与现有 functions/api/projects.js 完全一致（mysql 模式 + JWT 校验 + 服务令牌转发）。
import { mysqlMode, toServer, authUser } from './_proxy.js';
import { getCorsHeaders, jsonResponse } from './_auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  if (!mysqlMode(env)) {
    return jsonResponse({ error: 'phases 仅在 DATA_BACKEND=mysql 时可用' }, 501, corsHeaders);
  }

  const uname = await authUser(request, env);
  if (!uname) return jsonResponse({ error: '未授权：请登录' }, 401, corsHeaders);

  const sr = await toServer(request, env, { username: uname });
  return new Response(sr.body, {
    status: sr.status,
    headers: {
      'Access-Control-Allow-Origin': (corsHeaders && (corsHeaders['Access-Control-Allow-Origin'] || '*')) || '*',
      'Content-Type': sr.headers.get('Content-Type') || 'application/json',
    },
  });
}

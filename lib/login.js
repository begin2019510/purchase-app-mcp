'use strict';
// 本机网页登录：只监听 127.0.0.1，随机端口 + 一次性路径；
// 表单密码直接提交给 App 公网登录接口换取 refresh token，不写入磁盘、不写日志。
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

// 有图形界面时尝试自动打开登录页；无桌面环境时安静跳过，仍打印地址。
function tryOpenBrowser(url) {
  if (process.env.PURCHASE_APP_NO_OPEN === '1') return false;
  let cmd;
  let args;
  if (process.platform === 'darwin') {
    cmd = 'open'; args = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd'; args = ['/c', 'start', '', url];
  } else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    cmd = 'xdg-open'; args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #f4f5f7; color: #1f2329; padding: 24px; }
  .card { width: 100%; max-width: 420px; background: #fff; border-radius: 16px; padding: 32px 28px;
          box-shadow: 0 12px 40px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .sub { color: #646a73; font-size: 13px; line-height: 1.6; margin: 0 0 22px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
  input { width: 100%; padding: 11px 12px; font-size: 15px; border: 1px solid #d0d3d6; border-radius: 10px;
          outline: none; background: #fff; color: #1f2329; }
  input:focus { border-color: #3370ff; box-shadow: 0 0 0 3px rgba(51,112,255,.15); }
  button { width: 100%; margin-top: 22px; padding: 12px; font-size: 15px; font-weight: 600; color: #fff;
           background: #3370ff; border: 0; border-radius: 10px; cursor: pointer; }
  button:hover { background: #245bdb; }
  .err { background: #fff1f0; color: #d83931; border: 1px solid #ffd6d3; border-radius: 10px;
         padding: 10px 12px; font-size: 13px; margin-bottom: 6px; }
  .ok { text-align: center; }
  .ok .icon { width: 56px; height: 56px; line-height: 56px; margin: 0 auto 16px; border-radius: 50%;
              background: #e8f5e9; color: #2e7d32; font-size: 30px; }
  .foot { color: #8f959e; font-size: 12px; line-height: 1.6; margin-top: 18px; }
  code { background: #f2f3f5; padding: 1px 5px; border-radius: 4px; }
  @media (prefers-color-scheme: dark) {
    body { background: #17181a; color: #e8e9eb; }
    .card { background: #1f2023; box-shadow: none; border: 1px solid #2f3033; }
    .sub, .foot { color: #9a9da3; }
    input { background: #17181a; color: #e8e9eb; border-color: #3a3b3f; }
    .err { background: #3a1f1f; border-color: #5c2b2b; color: #ff8a80; }
    .ok .icon { background: #1f3a22; color: #8be28f; }
    code { background: #2a2b2f; }
  }
`;

function layout(inner) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 purchase-app-mcp</title>
<style>${STYLE}</style></head>
<body><div class="card">${inner}</div></body></html>`;
}

function formPage({ username, baseUrl, error }) {
  return layout(`
    <h1>连接购买 App</h1>
    <p class="sub">使用 App 账号登录，为这个 MCP 安装实例换取独立凭据。<br>
    目标服务：<code>${esc(baseUrl)}</code></p>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <form method="POST" autocomplete="on">
      <label for="u">用户名</label>
      <input id="u" name="username" value="${esc(username)}" autocomplete="username" required>
      <label for="p">密码</label>
      <input id="p" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">登录并授权</button>
    </form>
    <p class="foot">密码仅用于本次登录换 token，不会保存到磁盘或日志。<br>
    refresh token 保存在本机（0600），可用 <code>logout</code> 单独吊销。</p>
  `);
}

function successPage(username) {
  const safe = esc(username);
  return layout(`
    <div class="ok">
      <div class="icon">✓</div>
      <h1>登录成功</h1>
      <p class="sub">已为 <strong>${safe}</strong> 保存本机凭据。<br>可以关闭此页面，回到 agent 继续使用。</p>
    </div>
  `);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, html, extraHeaders) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...(extraHeaders || {}),
  });
  res.end(html);
}

/**
 * 启动本机登录页，等待用户提交账号密码。成功后 api 内部已保存 refresh token。
 * @returns {Promise<{ok:boolean, username:string, baseUrl:string}>}
 */
function interactiveLogin({ api, username, timeoutMs = 15 * 60 * 1000, autoOpen = true }) {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomBytes(18).toString('base64url');
    const loginPath = '/login/' + nonce;
    let attempts = 0;
    let finished = false;
    let timer = null;

    const server = http.createServer(async (req, res) => {
      let url;
      try {
        url = new URL(req.url, 'http://127.0.0.1');
      } catch (e) {
        return send(res, 400, layout('<h1>无效请求</h1>'));
      }
      if (url.pathname !== loginPath) {
        return send(res, 404, layout('<h1>页面不存在</h1>'));
      }
      if (req.method === 'GET') {
        return send(res, 200, formPage({ username, baseUrl: api.baseUrl, error: '' }));
      }
      if (req.method !== 'POST') {
        return send(res, 405, layout('<h1>不支持的请求方法</h1>'), { Allow: 'GET, POST' });
      }
      if (attempts >= 5) {
        return send(res, 429, formPage({ username, baseUrl: api.baseUrl, error: '尝试次数过多。请关闭并重新运行 login。' }));
      }

      let form;
      try {
        const raw = await readBody(req, 16 * 1024);
        form = new URLSearchParams(raw);
      } catch (e) {
        return send(res, 413, formPage({ username, baseUrl: api.baseUrl, error: '提交内容过大' }));
      }
      const u = String(form.get('username') || '').trim();
      const p = String(form.get('password') || '');
      if (!u || !p) {
        return send(res, 400, formPage({ username: u || username, baseUrl: api.baseUrl, error: '请输入用户名和密码' }));
      }

      attempts++;
      try {
        const out = await api.login(u, p);
        if (finished) return;
        finished = true;
        send(res, 200, successPage(out.username));
        cleanup();
        resolve(out);
      } catch (e) {
        if (finished) return;
        const msg = e && e.message ? e.message : '登录失败';
        send(res, 401, formPage({ username: u, baseUrl: api.baseUrl, error: msg }));
      }
    });

    function cleanup() {
      if (timer) { clearTimeout(timer); timer = null; }
      setTimeout(() => server.close(() => {}), 100).unref();
    }

    server.on('error', (e) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error('无法启动本机登录页：' + e.message));
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const url = 'http://127.0.0.1:' + port + loginPath;
      const opened = autoOpen && tryOpenBrowser(url);
      process.stderr.write(
        (opened ? '\n已尝试自动打开浏览器登录页。\n' : '\n请在浏览器中打开以下地址完成登录：\n') +
        '\n  ' + url + '\n\n' +
        '  · 使用 App 账号（默认 admin）和密码\n' +
        '  · 只保存 refresh token，不保存密码\n' +
        '  · 无浏览器？在能访问本机的终端做端口转发后打开同一地址，\n' +
        '    或设置 PURCHASE_APP_PASSWORD 后重新运行 login\n' +
        '  · 远程/跨设备：在 App 设置页生成一次性安装链接，改用 install <链接>\n\n'
      );
    });

    timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error('登录等待超时（15 分钟），请重新运行 login。'));
    }, timeoutMs);
    timer.unref();
  });
}

module.exports = { interactiveLogin };

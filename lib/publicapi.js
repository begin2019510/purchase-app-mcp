'use strict';
// 公网 App API 客户端（https://121212121.top/api/*）
// 鉴权：每个安装实例用自己的 App 账号登录，换取 access/refresh token；
//       access 24h 自动续期，refresh 30d 轮换；不包含、也不需要任何共享服务密钥。
const ACCESS_TTL_MS = 23 * 60 * 60 * 1000; // 服务端 24h，提前 1h 续期

const LOGIN_HINT =
  '尚未登录或登录已过期。请在终端运行 `purchase-app-mcp login` 完成登录' +
  '（npx 安装时：`npx -y github:begin2019510/purchase-app-mcp login`）。' +
  '登录在 127.0.0.1 网页中完成，只保存 refresh token，不保存密码。' +
  '也可以让 App 设置页生成一次性安装链接，再运行 `purchase-app-mcp install <链接>`。';

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
    this.code = 'AUTH_REQUIRED';
  }
}

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 0;
    this.body = body;
  }
}

function normalizeBaseUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch (e) {
    throw new Error('APP_BASE_URL 不是合法 URL：' + raw);
  }
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error('APP_BASE_URL 必须使用 https（本机调试可用 http://127.0.0.1）');
  }
  if (u.username || u.password) throw new Error('APP_BASE_URL 不能包含账号密码');
  const s = u.toString().replace(/\/+$/, '');
  return s;
}

function friendlyNetworkError(baseUrl, e) {
  const reason = e && e.name === 'TimeoutError' ? '请求超时' : (e && e.message ? e.message : String(e));
  return new ApiError('无法连接 ' + baseUrl + '：' + reason);
}

class PublicApi {
  constructor({ baseUrl, store, version = '1.0.0', timeoutMs = 30000 }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.store = store;
    this.version = version;
    this.timeoutMs = timeoutMs;

    this.username = '';
    this.refreshToken = '';
    this.accessToken = '';
    this.accessIssuedAt = 0;
    this._refreshing = null;
    this.baseMismatch = null;

    let saved = null;
    try {
      saved = this.store.read();
    } catch (e) {
      this.storeError = e.message;
    }
    if (saved) {
      const savedBase = saved.baseUrl ? normalizeBaseUrl(saved.baseUrl) : this.baseUrl;
      if (savedBase !== this.baseUrl) {
        // 绝不把为 A 服务签发的凭据发给 B 服务
        this.baseMismatch = { stored: savedBase, current: this.baseUrl };
      } else {
        this.username = saved.username || '';
        this.refreshToken = saved.refreshToken;
      }
    }
  }

  get loggedIn() {
    return !!this.refreshToken && !this.baseMismatch;
  }

  identityName() {
    if (!this.loggedIn) return '(未登录)';
    return this.username || '(已登录)';
  }

  authFile() {
    return this.store.file;
  }

  _loginHintSuffix() {
    if (this.storeError) return '（' + this.storeError + '）';
    if (this.baseMismatch) {
      return '（现有凭据属于 ' + this.baseMismatch.stored + '，当前 APP_BASE_URL 为 ' +
        this.baseMismatch.current + '；请重新 login）';
    }
    return '';
  }

  async _raw(method, path, body, token) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'purchase-app-mcp/' + this.version,
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    let res;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw friendlyNetworkError(this.baseUrl, e);
    }
    const text = await res.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    }
    return { res, body: parsed, text };
  }

  async login(username, password) {
    if (!username || !password) throw new ApiError('请输入用户名和密码');
    const { res, body } = await this._raw('POST', '/api/auth?action=login', { username, password });
    if (!res.ok || !body || !body.token) {
      const msg = (body && body.error) || ('登录失败（HTTP ' + res.status + '）');
      throw new ApiError(msg, res.status, body);
    }
    if (!body.refreshToken) throw new ApiError('登录响应缺少 refreshToken，无法保持登录', res.status, body);

    this.username = body.username || username;
    this.refreshToken = body.refreshToken;
    this.accessToken = body.token;
    this.accessIssuedAt = Date.now();
    this.baseMismatch = null;
    this.storeError = null;

    const now = new Date().toISOString();
    this.store.save({
      version: 1,
      baseUrl: this.baseUrl,
      username: this.username,
      refreshToken: this.refreshToken,
      createdAt: now,
      updatedAt: now,
    });
    this.store.audit({ event: 'login', ok: true, username: this.username, baseUrl: this.baseUrl });
    return { ok: true, username: this.username, baseUrl: this.baseUrl };
  }

  // 用 App 生成的一次性安装票据换取本安装实例独立的 refresh token。
  // 票据只用于兑换，不写入凭据文件；url 由 App 设置页生成。
  async exchangeAgentTicket(ticket) {
    if (typeof ticket !== 'string' || !ticket) throw new ApiError('安装链接缺少票据');
    const { res, body } = await this._raw('POST', '/api/auth?action=agent-exchange', { ticket });
    if (!res.ok || !body || !body.token || !body.refreshToken) {
      const msg = (body && body.error) || ('安装链接兑换失败（HTTP ' + res.status + '）');
      throw new ApiError(msg, res.status, body);
    }
    this.username = body.username || '';
    this.refreshToken = body.refreshToken;
    this.accessToken = body.token;
    this.accessIssuedAt = Date.now();
    this.baseMismatch = null;
    this.storeError = null;

    const now = new Date().toISOString();
    this.store.save({
      version: 1,
      baseUrl: this.baseUrl,
      username: this.username,
      refreshToken: this.refreshToken,
      createdAt: now,
      updatedAt: now,
      source: 'install-link',
    });
    this.store.audit({ event: 'agent_install', ok: true, username: this.username, baseUrl: this.baseUrl });
    return { ok: true, username: this.username, baseUrl: this.baseUrl };
  }

  // 生成一次性安装链接（需要已登录，access token 自动续期）。
  async createAgentTicket() {
    const body = await this.post('/api/auth?action=agent-ticket', {});
    if (!body || !body.ticket) throw new ApiError('App 没有返回安装票据（可能版本过旧）');
    return {
      ticket: body.ticket,
      expiresAt: body.expiresAt || null,
      url: this.baseUrl + '/agent#t=' + encodeURIComponent(body.ticket),
    };
  }

  async logout() {
    const rt = this.refreshToken;
    try {
      if (rt) await this._raw('POST', '/api/auth?action=logout', { refreshToken: rt });
    } catch (e) {
      // 服务端不可达也清除本机凭据；用户可用 `login` 重新授权
    } finally {
      const who = this.username;
      this.refreshToken = '';
      this.accessToken = '';
      this.accessIssuedAt = 0;
      this.store.clear();
      this.store.audit({ event: 'logout', ok: true, username: who });
    }
  }

  _adoptStored() {
    let saved = null;
    try { saved = this.store.read(); } catch (e) { throw new AuthError(e.message + this._loginHintSuffix()); }
    if (!saved) return false;
    const savedBase = saved.baseUrl ? normalizeBaseUrl(saved.baseUrl) : this.baseUrl;
    if (savedBase !== this.baseUrl) {
      this.baseMismatch = { stored: savedBase, current: this.baseUrl };
      throw new AuthError(LOGIN_HINT + this._loginHintSuffix());
    }
    if (saved.refreshToken && saved.refreshToken !== this.refreshToken) {
      // 另一个进程刚刚轮换过 refresh token：采用最新值，避免互相踢下线
      this.refreshToken = saved.refreshToken;
    }
    if (saved.username) this.username = saved.username;
    return true;
  }

  _applyRefresh(body) {
    this.accessToken = body.token;
    this.accessIssuedAt = Date.now();
    if (body.refreshToken) this.refreshToken = body.refreshToken;

    let prev = {};
    try { prev = this.store.read() || {}; } catch (e) { prev = {}; }
    this.store.save({
      version: 1,
      baseUrl: this.baseUrl,
      username: this.username || prev.username || '',
      refreshToken: this.refreshToken,
      createdAt: prev.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    this.store.audit({ event: 'token_refresh', ok: true, username: this.username });
    return this.accessToken;
  }

  async _doRefresh() {
    return this.store.withLock(async () => {
      this._adoptStored();
      if (!this.refreshToken) throw new AuthError(LOGIN_HINT + this._loginHintSuffix());

      const attempt = () => this._raw('POST', '/api/auth?action=refresh', { refreshToken: this.refreshToken });
      let out = await attempt();

      if (!out.res.ok) {
        // 锁内也可能遇到 login 刚写入新 token：再同步一次后重试一遍
        let latest = null;
        try { latest = this.store.read(); } catch (e) { latest = null; }
        if (latest && latest.refreshToken && latest.refreshToken !== this.refreshToken) {
          this.refreshToken = latest.refreshToken;
          out = await attempt();
        }
      }

      if (!out.res.ok || !out.body || !out.body.token) {
        const msg = (out.body && out.body.error) || ('HTTP ' + out.res.status);
        if (out.res.status === 401 || out.res.status === 400) {
          this.refreshToken = '';
          this.accessToken = '';
          this.accessIssuedAt = 0;
          try { this.store.clear(); } catch (e) { /* ignore */ }
          this.store.audit({ event: 'token_refresh', ok: false, username: this.username, error: msg });
          throw new AuthError(LOGIN_HINT + '（' + msg + '）');
        }
        throw new ApiError('刷新登录失败：' + msg, out.res.status, out.body);
      }

      return this._applyRefresh(out.body);
    });
  }

  async ensureAccessToken(force) {
    if (force) this.accessToken = '';
    if (this.accessToken && Date.now() - this.accessIssuedAt < ACCESS_TTL_MS) return this.accessToken;
    if (!this._refreshing) {
      this._refreshing = this._doRefresh().finally(() => { this._refreshing = null; });
    }
    await this._refreshing;
    return this.accessToken;
  }

  async request(path, { method = 'GET', body, retry = true } = {}) {
    const token = await this.ensureAccessToken(false);
    const out = await this._raw(method, path, body, token);

    if (out.res.status === 401 && retry) {
      await this.ensureAccessToken(true);
      return this.request(path, { method, body, retry: false });
    }

    if (!out.res.ok) {
      const msg = (out.body && out.body.error) || ('请求失败（HTTP ' + out.res.status + '）');
      if (out.res.status === 401) throw new AuthError(LOGIN_HINT + '（' + msg + '）');
      throw new ApiError(msg, out.res.status, out.body);
    }

    if (out.body === null && /^\s*</.test(out.text || '')) {
      throw new ApiError('接口 ' + path + ' 返回了网页而不是 JSON（该端点可能未在 App 公网 API 中部署）', out.res.status, null);
    }
    return out.body;
  }

  get(path) { return this.request(path, { method: 'GET' }); }
  post(path, body) { return this.request(path, { method: 'POST', body }); }
  put(path, body) { return this.request(path, { method: 'PUT', body }); }
  patch(path, body) { return this.request(path, { method: 'PATCH', body }); }
  del(path) { return this.request(path, { method: 'DELETE' }); }

  status() {
    let saved = null;
    try { saved = this.store.read(); } catch (e) { saved = null; }
    return {
      baseUrl: this.baseUrl,
      authFile: this.store.file,
      auditFile: this.store.auditFile,
      loggedIn: this.loggedIn,
      username: this.username || (saved && saved.username) || '',
      refreshTokenStored: !!(saved && saved.refreshToken),
      accessTokenCached: !!this.accessToken,
      baseMismatch: this.baseMismatch,
      storeError: this.storeError || null,
    };
  }
}

module.exports = { PublicApi, AuthError, ApiError, LOGIN_HINT, normalizeBaseUrl };

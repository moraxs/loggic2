import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { HttpError } from './pool.mjs';

const hash = value => {
  const salt = randomBytes(16).toString('hex');
  return { salt, digest: scryptSync(value, salt, 32).toString('hex') };
};
const matches = (value, saved) => {
  if (typeof value !== 'string' || value.length > 512 || !saved) return false;
  const expected = Buffer.from(saved.digest, 'hex');
  const incoming = scryptSync(value, saved.salt, 32);
  return incoming.length === expected.length && timingSafeEqual(incoming, expected);
};

export function createAuth(pool, env) {
  for (const name of ['LOGICC_ADMIN_PASSWORD', 'LOGICC_API_KEY']) {
    if (env[name] && (typeof env[name] !== 'string' || env[name].length > 512)) throw new Error(`${name} 最多允许 512 个字符`);
  }
  pool.data.settings ??= {};
  let generatedPassword;
  if (!env.LOGICC_ADMIN_PASSWORD && !pool.data.settings.adminPassword) {
    generatedPassword = randomBytes(18).toString('base64url');
    pool.data.settings.adminPassword = hash(generatedPassword);
    pool.save();
  }
  let adminPassword = pool.data.settings.adminPassword ?? hash(env.LOGICC_ADMIN_PASSWORD);
  const environmentKey = env.LOGICC_API_KEY ? hash(env.LOGICC_API_KEY) : null;
  const sessions = new Map();
  let attempts = 0, resetAt = 0;
  const verifyPassword = password => {
    if (Date.now() >= resetAt) { attempts = 0; resetAt = Date.now() + 60000; }
    if (attempts >= 10) throw new HttpError(429, '登录尝试过多，请一分钟后重试');
    if (!matches(password, adminPassword)) { attempts++; throw new HttpError(401, '管理密码不正确'); }
  };
  const sessionId = req => /(?:^|;\s*)logicc_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const cookie = (req, value, age) => `logicc_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${req.socket.encrypted || req.headers.origin === `https://${req.headers.host}` ? '; Secure' : ''}`;
  return {
    generatedPassword,
    authenticated(req) { return (sessions.get(sessionId(req)) || 0) > Date.now(); },
    require(req) { if (!this.authenticated(req)) throw new HttpError(401, '请先使用管理密码登录'); },
    login(req, res, password) {
      verifyPassword(password);
      for (const [id, expires] of sessions) if (expires <= Date.now()) sessions.delete(id);
      if (sessions.size >= 1000) throw new HttpError(429, '登录会话过多');
      sessions.delete(sessionId(req));
      const id = randomBytes(32).toString('hex');
      sessions.set(id, Date.now() + 12 * 3600000);
      res.setHeader('Set-Cookie', cookie(req, id, 12 * 3600));
    },
    logout(req, res) {
      sessions.delete(sessionId(req));
      res.setHeader('Set-Cookie', cookie(req, '', 0));
    },
    changePassword(req, res, input) {
      try { verifyPassword(input?.currentPassword); }
      catch (error) { if (error.status === 401) error.status = 403; throw error; }
      const value = input?.newPassword;
      if (typeof value !== 'string' || value.length < 8 || value.length > 512 || !value.trim()) throw new HttpError(400, '新管理密码需要 8–512 个字符，不能全为空白');
      const next = hash(value), previous = pool.data.settings.adminPassword;
      pool.data.settings.adminPassword = next;
      try { pool.save(); }
      catch (error) {
        if (previous === undefined) delete pool.data.settings.adminPassword;
        else pool.data.settings.adminPassword = previous;
        throw error;
      }
      adminPassword = next;
      sessions.clear(); attempts = 0; resetAt = 0;
      res.setHeader('Set-Cookie', cookie(req, '', 0));
    },
    requireBridge(req) {
      if (!this.authenticated(req)) verifyPassword(req.headers['x-logicc-password']);
    },
    apiKeyRequired() { return Boolean(pool.data.settings.apiKey ?? environmentKey); },
    checkApiKey(req) {
      const saved = pool.data.settings.apiKey ?? environmentKey;
      if (saved && (!req.headers.authorization?.startsWith('Bearer ') || !matches(req.headers.authorization.slice(7), saved))) throw new HttpError(401, '代理 API Key 不正确');
    },
    setApiKey(value) {
      if (typeof value !== 'string' || value.length < 1 || value.length > 512 || !/^[\x21-\x7e]+$/.test(value)) throw new HttpError(400, 'API Key 需要 1–512 个不含空格的可见 ASCII 字符');
      pool.data.settings.apiKey = hash(value);
      pool.save();
    },
  };
}

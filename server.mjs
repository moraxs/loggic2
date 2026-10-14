// Logicc → OpenAI adapter and local account-pool console. No runtime dependencies.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createAuth } from './auth.mjs';
import { AccountPool, HttpError, claims, safeError } from './pool.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

export async function* parseAiSdkStream(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  function parse(frame) {
    const text = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
    if (!text || text === '[DONE]') return null;
    try { return JSON.parse(text); } catch { throw new HttpError(502, '上游返回了无法解析的数据流'); }
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let separator;
    while ((separator = /\r?\n\r?\n/.exec(buffer))) {
      const event = parse(buffer.slice(0, separator.index));
      buffer = buffer.slice(separator.index + separator[0].length);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const event = parse(buffer); if (event) yield event; }
}

function mapTools(tools) {
  const builtins = { web_search: 'web-search', 'web-search': 'web-search', image_generation: 'image-generation', 'image-generation': 'image-generation' };
  let forcedTool;
  const custom = [];
  for (const tool of tools || []) {
    const name = tool?.function?.name ?? tool?.name;
    if (Object.hasOwn(builtins, name)) forcedTool = builtins[name];
    else if (tool?.function) custom.push(tool.function);
  }
  return { forcedTool, prompt: custom.length ? `\n\n[Tools available — if you need one, respond with a JSON block: {"tool_call": {"name": "<name>", "arguments": {...}}}]\n${JSON.stringify(custom)}` : '' };
}

function flattenMessages(messages) {
  return messages.map(message => {
    if (!message || typeof message.role !== 'string') throw new HttpError(400, 'messages 中的每条消息需要 role');
    if (message.content != null && typeof message.content !== 'string' && !Array.isArray(message.content)) throw new HttpError(400, '消息 content 必须为文本或内容数组');
    const content = typeof message.content === 'string' ? message.content : (message.content || []).filter(p => p?.type === 'text').map(p => p.text).join('\n');
    return message.role === 'user' ? content : `[${message.role}]\n${content}`;
  }).join('\n\n');
}

function readBody(req, limit = 1048576) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new HttpError(413, '请求体过大')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError(400, '请求已中断')));
  });
}
async function readJson(req) {
  const text = await readBody(req);
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, '请求体不是有效 JSON'); }
}
function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function usageOf(event) {
  const usage = event.totalUsage || event.usage || event.messageMetadata?.usage;
  if (!usage) return null;
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : value?.total;
  const input = number(usage.inputTokens) ?? usage.prompt_tokens;
  const output = number(usage.outputTokens) ?? usage.completion_tokens;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

export function createAdapter({ env = process.env, dataFile = env.LOGICC_DATA_FILE || resolve(ROOT, 'data/state.json') } = {}) {
  const pool = new AccountPool(dataFile, env);
  const auth = createAuth(pool, env);
  const apiBase = (env.LOGICC_API_BASE || 'https://app.logicc.com/api').replace(/\/+$/, '');

  async function upstream(account, path, { method = 'GET', body, stream = false, signal } = {}, retry = true) {
    const token = await pool.tokenFor(account);
    const response = await fetch(`${apiBase}/${path}`, {
      method, signal, redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: stream ? 'text/event-stream' : 'application/json',
        ...(stream ? { 'Stream-Response-Protocol': 'ai-sdk-v6' } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401 && retry) {
      await response.body?.cancel();
      await pool.tokenFor(account, true);
      return upstream(account, path, { method, body, stream, signal }, false);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status, `上游 ${path.split('?')[0].startsWith('chats/') ? '聊天' : path.split('?')[0]} 请求失败（HTTP ${response.status}）`);
    }
    return response;
  }

  async function modelsFor(account, signal) {
    const response = await upstream(account, 'models?language=en', { signal });
    const data = await response.json();
    const list = Array.isArray(data) ? data : data.models ?? data.data;
    if (!Array.isArray(list)) throw new HttpError(502, '上游模型列表格式不正确');
    const models = list.filter(m => typeof (m.id ?? m.modelId) === 'string').map(m => ({
      id: m.id ?? m.modelId, name: typeof m.name === 'string' ? m.name : m.id ?? m.modelId,
      provider: typeof m.provider === 'string' ? m.provider : typeof m.provider?.name === 'string' ? m.provider.name : 'logicc',
      isDefault: Boolean(m.isDefault),
    }));
    if (!models.length) throw new HttpError(502, '上游没有返回可用模型');
    pool.data.models = models;
    pool.data.modelsUpdatedAt = Date.now();
    return models;
  }

  async function track(req, res, kind, operation, accountId) {
    const trace = { kind, startedAt: Date.now(), model: null, ttftMs: null, status: 'success', stream: false, usage: null };
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
    let account;
    try {
      account = accountId ? pool.account(accountId) : pool.acquire();
      if (accountId) pool.runtimeFor(account.id).inFlight++;
      trace.accountId = account.id;
      trace.accountName = account.name;
      const result = await operation(account, trace, signal);
      pool.healthy(account);
      return result;
    } catch (error) {
      if (signal.aborted) error = new HttpError(controller.signal.aborted ? 499 : 504, controller.signal.aborted ? '客户端已取消请求' : '上游请求超时');
      trace.status = error.status === 499 ? 'cancelled' : 'error';
      trace.error = safeError(error);
      trace.httpStatus = error.status || 502;
      if (account && error.status !== 499) pool.failed(account, error);
      throw error;
    } finally {
      res.off('close', onClose);
      trace.durationMs = Date.now() - trace.startedAt;
      if (account) pool.release(account);
      pool.record(trace);
    }
  }

  async function chat(req, res) {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || !body.messages.length) throw new HttpError(400, 'messages 需要非空数组');
    if (body.tools !== undefined && !Array.isArray(body.tools)) throw new HttpError(400, 'tools 必须为数组');
    if (body.model !== undefined && typeof body.model !== 'string') throw new HttpError(400, 'model 必须为字符串');
    if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new HttpError(400, 'stream 必须为布尔值');
    const tools = mapTools(body.tool_choice === 'none' ? [] : body.tools);
    const prompt = flattenMessages(body.messages) + tools.prompt;
    if (!prompt.trim()) throw new HttpError(400, '消息内容不能为空');
    await track(req, res, 'chat', async (account, trace, signal) => {
      let model = body.model;
      if (!model || model === 'default') {
        const models = await modelsFor(account, signal);
        model = (models.find(m => m.isDefault) || models[0]).id;
      }
      trace.model = model;
      trace.stream = Boolean(body.stream);
      const chatResponse = await upstream(account, 'chats', { method: 'POST', body: {}, signal });
      const createdChat = await chatResponse.json();
      const id = typeof createdChat === 'string' ? createdChat : createdChat.id;
      if (typeof id !== 'string' || !id) throw new HttpError(502, '上游创建会话未返回 ID');
      const response = await upstream(account, `chats/${encodeURIComponent(id)}`, {
        method: 'POST', stream: true, signal,
        body: { modelId: model, prompt, isVoicePrompt: false,
          ...(body.reasoning_effort ? { reasoningEffort: body.reasoning_effort } : {}),
          ...(tools.forcedTool ? { forcedTool: tools.forcedTool } : {}) },
      });
      const created = Math.floor(Date.now() / 1000);
      const base = { id: `chatcmpl-${id}`, created, model };
      const chunk = (delta, finishReason = null) => ({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }] });
      const send = data => { if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`); };
      let content = '';
      let finished = false;
      let finishReason = 'stop';
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        send(chunk({ role: 'assistant' }));
      }
      for await (const event of parseAiSdkStream(response.body)) {
        if (event.type === 'error') throw new HttpError(502, `上游流错误：${safeError(event.errorText || '未知错误')}`);
        let delta = '';
        if (event.type === 'text-delta' && event.delta) {
          delta = event.delta;
          trace.ttftMs ??= Date.now() - trace.startedAt;
        } else if (event.type === 'tool-input-start') delta = `\n[tool:${event.toolName ?? 'unknown'}] `;
        else if (event.type === 'tool-input-delta') delta = event.inputTextDelta || event.delta || '';
        if (delta) { if (body.stream) send(chunk({ content: delta })); else content += delta; }
        const usage = usageOf(event);
        if (usage) trace.usage = usage;
        if (event.type === 'finish') {
          finished = true;
          finishReason = ['stop', 'length', 'content_filter'].includes(event.finishReason) ? event.finishReason : 'stop';
        }
      }
      if (!finished) throw new HttpError(502, '上游数据流提前结束，未收到 finish 事件');
      const usage = trace.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      if (body.stream) {
        send(chunk({}, finishReason));
        if (body.stream_options?.include_usage) send({ ...base, object: 'chat.completion.chunk', choices: [], usage });
        res.end('data: [DONE]\n\n');
      } else {
        json(res, 200, { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }], usage });
      }
    });
  }

  const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      if (!host || !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::\d{1,5})?$/.test(host)) throw new HttpError(400, 'HTTP Host 格式不正确');
      const url = new URL(req.url, `http://${host}`);
      const origin = req.headers.origin;
      const bridge = url.pathname === '/__set_token' && origin === 'https://app.logicc.com';
      if (origin && ![`http://${host}`, `https://${host}`].includes(origin) && !bridge) throw new HttpError(403, '不允许此网页来源访问控制台');
      if (req.headers['sec-fetch-site'] === 'cross-site' && !bridge) throw new HttpError(403, '不允许跨站访问');
      if (bridge) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Logicc-Password');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (assets[url.pathname] && ['GET', 'HEAD'].includes(req.method)) {
        const [file, type] = assets[url.pathname];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : readFileSync(resolve(ROOT, 'public', file)));
        return;
      }
      if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { status: 'ok', uptime: Math.floor((Date.now() - pool.startedAt) / 1000) });
      if (url.pathname.startsWith('/api/')) {
        if (req.headers['x-logicc-admin'] !== '1') throw new HttpError(403, '控制台请求缺少 X-Logicc-Admin 请求头');
        if (!['GET', 'DELETE'].includes(req.method) && !req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '管理接口需要 application/json');
        if (url.pathname === '/api/login' && req.method === 'POST') {
          auth.login(req, res, (await readJson(req))?.password);
          return json(res, 200, { ok: true });
        }
        auth.require(req);
        if (url.pathname === '/api/logout' && req.method === 'POST') {
          auth.logout(req, res);
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/settings/api-key' && req.method === 'PUT') {
          auth.setApiKey((await readJson(req))?.apiKey);
          return json(res, 200, { ok: true, apiKeyRequired: true });
        }
        if (url.pathname === '/api/settings/admin-password' && req.method === 'PUT') {
          auth.changePassword(req, res, await readJson(req));
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, {
          ...pool.snapshot(), service: { baseUrl: `${origin === `https://${host}` ? 'https' : 'http'}://${host}/v1`, upstream: apiBase, apiKeyRequired: auth.apiKeyRequired(), strategy: 'least-busy-round-robin' },
        });
        if (url.pathname === '/api/accounts' && req.method === 'POST') {
          const input = await readJson(req);
          return json(res, 201, { account: pool.addMany([input])[0] });
        }
        if (url.pathname === '/api/accounts/import' && req.method === 'POST') {
          const input = await readJson(req);
          return json(res, 201, { accounts: pool.addMany(Array.isArray(input) ? input : input?.accounts) });
        }
        const match = /^\/api\/accounts\/([\w-]+)(?:\/(check|refresh))?$/.exec(url.pathname);
        if (match) {
          const [, id, action] = match;
          if (req.method === 'PATCH' && !action) return json(res, 200, { account: pool.update(id, await readJson(req)) });
          if (req.method === 'DELETE' && !action) { pool.remove(id); return json(res, 200, { ok: true }); }
          if (req.method === 'POST' && action) {
            const result = await track(req, res, 'check', async (account, trace, signal) => {
              if (action === 'refresh') await pool.tokenFor(account, true);
              const models = await modelsFor(account, signal);
              return { models: models.length };
            }, id);
            return json(res, 200, { ...result, account: pool.publicAccount(pool.account(id)) });
          }
        }
        if (url.pathname === '/api/models/refresh' && req.method === 'POST') {
          const models = await track(req, res, 'models', (account, _trace, signal) => modelsFor(account, signal));
          return json(res, 200, { models, updatedAt: pool.data.modelsUpdatedAt });
        }
        throw new HttpError(404, '管理接口不存在');
      }
      if (url.pathname === '/__set_token' && req.method === 'POST') {
        auth.requireBridge(req);
        const token = (await readBody(req, 25000)).trim().replace(/^(['"])(.*)\1$/, '$2');
        const sid = claims(token).sid;
        const requested = url.searchParams.get('account_id');
        const existing = requested ? pool.account(requested) : pool.data.accounts.find(a => a.sessionId === sid);
        if (existing && existing.sessionId && existing.sessionId !== sid) throw new HttpError(400, 'JWT 不属于指定账户');
        const account = existing ? pool.update(existing.id, { token }) : pool.addMany([{ name: '浏览器账户', token }])[0];
        return json(res, 200, { ok: true, accountId: account.id, exp: claims(token).exp });
      }
      if (url.pathname.startsWith('/v1/')) auth.checkApiKey(req);
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        const models = await track(req, res, 'models', (account, _trace, signal) => modelsFor(account, signal));
        return json(res, 200, { object: 'list', data: models.map(m => ({ id: m.id, object: 'model', created: 0, owned_by: m.provider })) });
      }
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return await chat(req, res);
      throw new HttpError(404, '接口不存在');
    } catch (error) {
      const message = safeError(error);
      if (res.headersSent) {
        if (!res.destroyed && !res.writableEnded) res.end(`data: ${JSON.stringify({ error: { message, type: 'adapter_error' } })}\n\ndata: [DONE]\n\n`);
      } else json(res, error.status >= 400 && error.status <= 599 ? error.status : 502, { error: { message, type: 'adapter_error' } });
    }
  });
  return { server, pool, auth };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.PORT || 18789);
  const host = process.env.LOGICC_HOST || '0.0.0.0';
  const { server, auth } = createAdapter();
  server.listen(port, host, () => {
    console.log(`Listening:     ${host}:${server.address().port}`);
    if (auth.generatedPassword) console.log(`管理密码（请保存）: ${auth.generatedPassword}`);
    console.log(`Logicc console: http://127.0.0.1:${server.address().port}/`);
    console.log(`OpenAI API:    http://127.0.0.1:${server.address().port}/v1`);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

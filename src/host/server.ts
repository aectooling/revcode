import { validateExecuteInput } from './execute-input.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import type { Agent, AuthState, Context, ExecuteInput, Message, Operation, Settings } from './types.js';
import { Router } from 'zeromq';

const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const statuses = new Set(['compiling', 'queued', 'running', ...terminal, 'unknown']);
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
interface Persisted { messages: Message[]; operations: Operation[]; requests: Record<string, { fingerprint: string; response: object }>; settings: Settings }
export interface HostOptions { instanceId: string; nativeToken: string; dataDir: string; webDir: string; agent: Agent; heartbeatMs?: number; userDir?: string }

export async function createHost(options: HostOptions) {
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  const journal = resolve(options.dataDir, 'journal.json');
  let state: Persisted = { messages: [], operations: [], requests: {}, settings: { provider: 'anthropic', model: options.agent.providers.find(p => p.id === 'anthropic')?.models[0]?.id ?? '', configured: false } };
  try { state = JSON.parse(await readFile(journal, 'utf8')) as Persisted; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const settingsFile = resolve(options.userDir ?? options.dataDir, 'settings.json');
  await mkdir(resolve(options.userDir ?? options.dataDir), { recursive: true, mode: 0o700 });
  try { state.settings = JSON.parse(await readFile(settingsFile, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  for (const op of state.operations) if (!terminal.has(op.status)) { op.status = 'unknown'; op.error = 'Host restarted before a confirmed native outcome. Do not replay this operation.'; }
  let context: Context | null = null, lastHeartbeat = 0, chatBusy = false;
  let auth: AuthState = { busy: false, completedCount: 0 };
  let authController: AbortController | undefined;
  let authResponse: { id: string; resolve: (value: string) => void; reject: (error: Error) => void } | undefined;
  const router = new Router({ linger: 0, maxMessageSize: 1024 * 1024 });
  await router.bind('tcp://127.0.0.1:*');
  const nativeEndpoint = router.lastEndpoint!;
  let nativeRoute: Buffer | undefined;
  const queue: object[] = [], events = new Set<ServerResponse>();
  const waiters = new Map<string, { resolve: (op: Operation) => void; reject: (e: Error) => void }>();
  const browserToken = randomBytes(32).toString('hex');
  let url = '';
  let saveChain = Promise.resolve();
  const persist = () => {
    const data = JSON.stringify(state);
    saveChain = saveChain.then(async () => { await writeFile(`${journal}.tmp`, data, { mode: 0o600 }); await rename(`${journal}.tmp`, journal); });
    return saveChain;
  };
  await persist();
  const connected = () => lastHeartbeat > 0 && Date.now() - lastHeartbeat < (options.heartbeatMs ?? 10000);
  const busy = () => chatBusy || state.operations.some(o => !terminal.has(o.status));
  const snapshot = () => ({ instanceId: options.instanceId, context, connected: connected(), busy: busy(), auth, ...state, requests: undefined,
    operations: state.operations.slice(-100), messages: state.messages.slice(-200), settings: { ...state.settings, configured: options.agent.configured(state.settings.provider) }, providers: options.agent.providers });
  let broadcastTimer: NodeJS.Timeout | undefined;
  const broadcast = () => { if (broadcastTimer || events.size === 0) return; broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined; const data = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of events) { if (res.writableLength > 1024 * 1024) { res.end(); events.delete(res); } else res.write(data); }
  }, 50); };
  const send = (res: ServerResponse, status: number, body?: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
  let sendChain = Promise.resolve();
  const dispatch = (command: object) => {
    if (!nativeRoute) { queue.push(command); return; }
    const route = nativeRoute;
    sendChain = sendChain.then(() => router.send([route, JSON.stringify({ type: 'command', command })])).catch(() => {
      const work = mutationChain.then(markDisconnected); mutationChain = work.catch(() => {});
    });
  };
  const markDisconnected = async () => {
    lastHeartbeat = 0;
    nativeRoute = undefined;
    for (const op of state.operations) if (!terminal.has(op.status) && op.status !== 'unknown') {
      op.status = 'unknown'; op.error = 'Native connection lost; execution outcome is unknown. Do not retry.';
      waiters.get(op.operationId)?.resolve(op); waiters.delete(op.operationId);
    }
    queue.length = 0;
    await persist(); broadcast();
  };
  const validate = (input: any): ExecuteInput => {
    try { return validateExecuteInput(input); } catch (error) { throw new HttpError(400, (error as Error).message); }
  };
  const checkDocument = () => {
    if (!connected()) throw new HttpError(409, 'Revit is disconnected.');
    if (state.operations.some(o => !terminal.has(o.status))) throw new HttpError(409, 'An operation is pending or its outcome is unknown.');
    return context?.document;
  };
  const createOperation = async (input: ExecuteInput) => {
    const validated = validate(input);
    const activeDocument = checkDocument();
    const token = validated.documentToken === undefined ? activeDocument?.token ?? null : validated.documentToken;
    const doc = token === null ? null : (context?.documents ?? (activeDocument ? [activeDocument] : [])).find(d => d.token === token);
    if (token !== null && !doc) throw new HttpError(409, 'The target document is no longer open. Refresh the document list.');
    if ((validated.mode === 'modify' || validated.mode === 'batch') && !doc) throw new HttpError(409, 'Modify requires an open target document.');
    if ((validated.mode === 'modify' || validated.mode === 'batch') && doc?.isReadOnly) throw new HttpError(409, 'Document is read-only.');
    const op: Operation = { ...validated, operationId: randomUUID(), documentToken: token, createdAt: new Date().toISOString(), status: 'queued' };
    state.operations.push(op);
    await persist();
    return op;
  };
  const execute = async (input: ExecuteInput, signal?: AbortSignal): Promise<Operation> => {
    if (signal?.aborted) throw new Error('Cancelled');
    const op = await createOperation(input);
    const waiting = new Promise<Operation>((resolve, reject) => waiters.set(op.operationId, { resolve, reject }));
    const cancel = () => dispatch({ kind: 'cancel', operationId: op.operationId });
    signal?.addEventListener('abort', cancel, { once: true });
    dispatch({ kind: 'execute', ...op }); broadcast();
    if (signal?.aborted) cancel();
    try { return await waiting; } finally { signal?.removeEventListener('abort', cancel); }
  };
  const body = async (req: IncomingMessage): Promise<any> => {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new HttpError(413, 'Request too large.'); chunks.push(chunk); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; } catch { throw new HttpError(400, 'Expected JSON object.'); }
  };
  const authorized = (req: IncomingMessage, token: string) => {
    const actual = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const dedup = (data: any) => {
    if (typeof data.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(data.requestId)) throw new HttpError(400, 'A stable requestId is required.');
    const fingerprint = JSON.stringify(data);
    const old = state.requests[data.requestId];
    if (old && old.fingerprint !== fingerprint) throw new HttpError(409, 'requestId was already used for different content.');
    return { old, fingerprint };
  };
  // Serialize state-changing requests across asynchronous disk writes.
  let mutationChain = Promise.resolve();
  async function mutate(req: IncomingMessage, res: ServerResponse, path: string) {
    const data = await body(req);
    if (path === '/api/auth/respond') {
      if (!authResponse || data.requestId !== authResponse.id || typeof data.value !== 'string' || data.value.length > 16384) throw new HttpError(400, 'This sign-in prompt is no longer active.');
      if (auth.request?.type === 'select' && !auth.request.options?.some(option => option.id === data.value)) throw new HttpError(400, 'Choose an available option.');
      const response = authResponse; authResponse = undefined; auth.request = undefined; response.resolve(data.value); send(res, 200, { ok: true }); broadcast(); return;
    }
    if (path === '/api/auth/cancel') { authController?.abort(); send(res, 200, { ok: true }); return; }
    if (path.startsWith('/api/auth/')) {
      if (busy() || auth.busy) throw new HttpError(409, 'Wait for the current operation or sign-in to finish.');
      if (path === '/api/auth/refresh') { await options.agent.refresh?.(); send(res, 200, { ok: true }); broadcast(); return; }
      if (path === '/api/auth/provider') {
        if (!options.agent.addProvider || typeof data.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(data.id) || typeof data.baseUrl !== 'string' || !Array.isArray(data.models) || !data.models.length || data.models.length > 50 || data.models.some((m: any) => typeof m.id !== 'string' || !m.id.trim() || m.id.length > 200 || (m.name !== undefined && (typeof m.name !== 'string' || m.name.length > 200)) || (m.supportsImages !== undefined && typeof m.supportsImages !== 'boolean'))) throw new HttpError(400, 'A provider ID, base URL, and model IDs are required.');
        let endpoint: URL; try { endpoint = new URL(data.baseUrl); } catch { throw new HttpError(400, 'Invalid API base URL.'); }
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new HttpError(400, 'Use an HTTP(S) API base URL without embedded credentials, query, or fragment.');
        if (data.apiKey !== undefined && (typeof data.apiKey !== 'string' || data.apiKey.length > 8192)) throw new HttpError(400, 'Invalid API key.');
        if (data.name !== undefined && (typeof data.name !== 'string' || data.name.length > 200)) throw new HttpError(400, 'Invalid provider name.');
        if (options.agent.providers.some(p => p.id === data.id)) throw new HttpError(409, 'That provider ID already exists.');
        await options.agent.addProvider({ id: data.id, name: data.name, baseUrl: endpoint.toString().replace(/\/$/, ''), apiKey: data.apiKey, models: data.models });
        send(res, 200, { ok: true }); broadcast(); return;
      }
      const provider = options.agent.providers.find(p => p.id === data.provider);
      if (!provider) throw new HttpError(400, 'Unknown provider.');
      if (path === '/api/auth/logout') {
        if (!provider.canLogout || !options.agent.logout) throw new HttpError(400, 'This credential is managed outside Revcode.');
        await options.agent.logout(provider.id); send(res, 200, { ok: true }); broadcast(); return;
      }
      if (path !== '/api/auth/login' || !options.agent.login || !provider.authMethods?.some(m => m.type === data.authType)) throw new HttpError(400, 'Unsupported sign-in method.');
      if (data.apiKey !== undefined && (typeof data.apiKey !== 'string' || data.apiKey.length > 8192)) throw new HttpError(400, 'Invalid API key.');
      const controller = new AbortController(); authController = controller;
      auth = { provider: provider.id, busy: true, completedCount: auth.completedCount, notice: 'Starting sign-in…' };
      const timeout = setTimeout(() => controller.abort(), 300000);
      let suppliedKey = data.apiKey?.trim();
      void options.agent.login(provider.id, data.authType, {
        signal: controller.signal,
        notify: event => {
          if (event.type === 'auth_url') { auth.url = event.url; auth.notice = event.instructions; }
          else if (event.type === 'device_code') { auth.url = event.verificationUri; auth.userCode = event.userCode; }
          else { auth.notice = event.message; if (event.type === 'info' && event.links?.[0]) auth.url = event.links[0].url; }
          broadcast();
        },
        prompt: async prompt => {
          if (prompt.type === 'secret' && suppliedKey) { const value = suppliedKey; suppliedKey = undefined; return value; }
          const signal = prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal;
          if (signal.aborted) throw new Error('Sign-in cancelled.');
          const id = randomUUID();
          auth.request = { requestId: id, prompt: prompt.message, type: prompt.type, password: prompt.type === 'secret', ...('placeholder' in prompt ? { placeholder: prompt.placeholder } : {}), ...('options' in prompt ? { options: prompt.options } : {}) };
          broadcast();
          return new Promise<string>((resolve, reject) => {
            const cancel = () => { if (authResponse?.id === id) { authResponse = undefined; auth.request = undefined; } reject(new Error('Sign-in cancelled.')); broadcast(); };
            signal.addEventListener('abort', cancel, { once: true });
            authResponse = { id, resolve: value => { signal.removeEventListener('abort', cancel); resolve(value); }, reject };
            if (signal.aborted) cancel();
          });
        },
      }).then(() => { auth.completedCount++; auth.notice = 'Connected.'; }).catch(() => { auth.error = controller.signal.aborted ? 'Sign-in cancelled or timed out.' : 'Sign-in failed. Retry provider setup and check the account or API key.'; }).finally(() => {
        clearTimeout(timeout); authController = undefined; authResponse = undefined; auth.busy = false; auth.request = undefined; auth.url = undefined; auth.userCode = undefined; broadcast();
      });
      send(res, 202, { ok: true }); broadcast(); return;
    }
    if (path === '/api/settings') {
      if (busy() || auth.busy) throw new HttpError(409, 'Wait for the current operation or sign-in to finish.');
      if (!options.agent.providers.some(p => p.id === data.provider && p.models.some(m => m.id === data.model))) throw new HttpError(400, 'Unknown provider/model.');
      if (data.apiKey !== undefined && (typeof data.apiKey !== 'string' || data.apiKey.length > 8192)) throw new HttpError(400, 'Invalid API key.');
      if (data.apiKey?.trim()) await options.agent.setKey(data.provider, data.apiKey.trim());
      state.settings = { provider: data.provider, model: data.model, configured: options.agent.configured(data.provider) };
      const tempSettings = `${settingsFile}.${randomUUID()}.tmp`;
      await writeFile(tempSettings, JSON.stringify(state.settings), { mode: 0o600 }); await rename(tempSettings, settingsFile);
      await persist(); send(res, 200, state.settings); broadcast(); return;
    }
    if (path === '/api/cancel') {
      for (const op of state.operations) if (!terminal.has(op.status)) dispatch({ kind: 'cancel', operationId: op.operationId });
      void options.agent.abort().catch(() => {}); send(res, 200, { ok: true }); return;
    }
    if (path === '/api/execute' || path === '/api/chat') {
      const { old, fingerprint } = dedup(data);
      if (old) { send(res, 202, old.response); return; }
      if (busy() || auth.busy) throw new HttpError(409, 'Revcode is busy or awaiting an uncertain outcome.');
      checkDocument();
      if (path === '/api/execute') {
        const op = await createOperation(validate(data));
        const response = { operationId: op.operationId };
        state.requests[data.requestId] = { fingerprint, response }; await persist();
        dispatch({ kind: 'execute', ...op }); send(res, 202, response); broadcast(); return;
      }
      if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 32000) throw new HttpError(400, 'Message must contain 1–32000 characters.');
      if (!options.agent.configured(state.settings.provider)) throw new HttpError(409, 'Connect a provider first.');
      const response = { requestId: data.requestId };
      state.requests[data.requestId] = { fingerprint, response };
      const history = [...state.messages];
      state.messages.push({ id: randomUUID(), role: 'user', text: data.text });
      const message: Message = { id: randomUUID(), role: 'assistant', text: '' }; state.messages.push(message);
      chatBusy = true; await persist(); send(res, 202, response); broadcast();
      const boundContext = structuredClone(context!);
      void options.agent.prompt(data.text, state.settings, boundContext, history, async (input, signal) => {
        if (context?.document?.token !== boundContext.document?.token) throw new Error('Active document changed during this turn. Start a new turn.');
        return execute(input, signal);
      }, text => { message.text = text.slice(0, 200000); broadcast(); }).catch(error => { message.text += `\n${error instanceof Error ? error.message : 'Agent failed'}`; }).finally(async () => { chatBusy = false; await persist(); broadcast(); });
      return;
    }
    throw new HttpError(404, 'Not found.');
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(url).host) throw new HttpError(403, 'Invalid Host.');
      if (req.headers.origin && req.headers.origin !== url) throw new HttpError(403, 'Invalid Origin.');
      const path = new URL(req.url ?? '/', url).pathname;
      if (path.startsWith('/api/')) {
        if (!authorized(req, browserToken)) throw new HttpError(401, 'Unauthorized.');
        if (req.method === 'GET' && path === '/api/state') { send(res, 200, snapshot()); return; }
        if (req.method === 'GET' && path === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          events.add(res); res.on('close', () => events.delete(res)); res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`); return;
        }
        if (req.method !== 'POST') throw new HttpError(404, 'Not found.');
        const work = mutationChain.then(() => mutate(req, res, path)); mutationChain = work.catch(() => {}); await work; return;
      }
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      const root = resolve(options.webDir); const file = resolve(root, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
      if (!file.startsWith(root + sep)) throw new HttpError(403, 'Invalid path.');
      const content = await readFile(file).catch(() => { throw new HttpError(404, 'UI asset not found. Run npm run build.'); });
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" }); res.end(content);
    } catch (error) { if (!res.headersSent) send(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Internal host error. Check installation and data directory.' }); else res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  void (async () => {
    try { for await (const frames of router) {
      if (frames.length !== 2) continue;
      const [route, frame] = frames;
      try {
        const envelope = JSON.parse(frame!.toString());
        if (typeof envelope.token !== 'string') continue;
        const received = Buffer.from(envelope.token), expected = Buffer.from(options.nativeToken);
        if (received.length !== expected.length || !timingSafeEqual(received, expected)) continue;
        const data = envelope.payload;
        const work = mutationChain.then(async () => {
          if (envelope.type === 'context') {
            if (data?.instanceId !== options.instanceId || (data.document !== null && typeof data.document?.token !== 'string')) return;
            context = data; lastHeartbeat = Date.now(); nativeRoute = route;
            while (queue.length) dispatch(queue.shift()!); broadcast();
          } else if (envelope.type === 'disconnect') { await markDisconnected(); }
          else if (envelope.type === 'operation') {
            const op = state.operations.find(o => o.operationId === data?.operationId);
            if (!op || !statuses.has(data.status)) return;
            if (!terminal.has(op.status)) {
              for (const key of ['status', 'result', 'logs', 'diagnostics', 'error', 'transactionStatus', 'elapsedMs'] as const) if (data[key] !== undefined) (op as any)[key] = data[key];
              await persist(); broadcast();
              if (terminal.has(op.status) || op.status === 'unknown') { waiters.get(op.operationId)?.resolve(op); waiters.delete(op.operationId); }
            }
            sendChain = sendChain.then(() => router.send([route!, JSON.stringify({ type: 'ack', operationId: op.operationId, status: op.status })])).catch(() => {});
          }
        }); mutationChain = work.catch(() => {}); await work;
      } catch { /* Malformed authenticated native frame is ignored, never dispatched. */ }
    } } catch { /* Socket closes during host shutdown. */ }
  })();
  const heartbeat = setInterval(() => {
    const work = mutationChain.then(async () => { if (lastHeartbeat && !connected()) await markDisconnected(); }); mutationChain = work.catch(() => {});
  }, 1000); heartbeat.unref();
  return { url, nativeEndpoint, browserToken, snapshot, close: async () => { authController?.abort(); clearInterval(heartbeat); clearTimeout(broadcastTimer); for (const waiter of waiters.values()) waiter.reject(new Error('Host closed')); await options.agent.abort(); for (const res of events) res.end(); router.close(); await saveChain; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

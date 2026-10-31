// The HTTP API from PROTOCOL.md as a web-standard fetch handler:
// (Request) => Promise<Response>. Works as a Next.js route handler, in Hono,
// Bun, Deno and Workers; nodeHandler() adapts it to Express and node:http.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status, error, message) => json({ error, message }, status);

async function body(request) {
  const type = request.headers.get('content-type') ?? '';
  const text = await request.text();
  if (!text) return {};
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Body is not JSON.'), { status: 400, code: 'bad_request' });
  }
}

/**
 * @param {ReturnType<import('./index.js').createApprovals>} approvals
 * @param {{ getUser: (request: Request) => unknown, canReview?: (user: object, request: object | null) => unknown,
 *   basePath?: string }} options
 */
export function createHandler(approvals, options) {
  if (typeof options?.getUser !== 'function') throw new TypeError('handler() needs getUser(request).');
  const base = (options.basePath ?? '').replace(/\/+$/, '');
  const canReview = options.canReview ?? (() => true);
  const nameOf = (user) => String(user.name ?? user.id);

  return async function handle(request) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (base && path.startsWith(base)) path = path.slice(base.length);
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const method = request.method.toUpperCase();

    try {
      const user = await options.getUser(request);
      if (!user || user.id == null) return fail(401, 'unauthenticated', 'Sign in to review approvals.');

      if (method === 'POST' && parts.length === 1 && parts[0] === 'auth') {
        if (!(await canReview(user, null))) return fail(403, 'forbidden', 'You may not review approvals.');
        const b = await body(request);
        const auth = approvals.authorize(String(b.socket_id ?? ''), String(b.channel_name ?? ''), user);
        return auth ? json(auth) : fail(403, 'forbidden', 'Unknown channel.');
      }

      if (method === 'GET' && parts.length === 0) {
        if (!(await canReview(user, null))) return fail(403, 'forbidden', 'You may not review approvals.');
        const status = url.searchParams.get('status') ?? 'pending';
        if (!['pending', 'done', 'all'].includes(status)) return fail(400, 'bad_request', 'status is pending, done or all.');
        const data = await approvals.list({ status });
        const visible = [];
        for (const r of data) if (await canReview(user, r)) visible.push(r);
        return json({ data: visible });
      }

      if (parts.length === 0) return fail(405, 'method_not_allowed', 'Use GET.');
      const record = await approvals.get(parts[0]);
      if (!(await canReview(user, record))) return fail(403, 'forbidden', 'You may not review this request.');
      const by = nameOf(user);
      const [, action, callId] = parts;

      if (method === 'GET' && parts.length === 1) return json(record);
      if (method === 'POST' && action === 'decisions' && parts.length === 2) {
        const b = await body(request);
        return json(await approvals.decide(record.id, b.decisions, { by, send: b.send === true }));
      }
      if (method === 'DELETE' && action === 'decisions' && callId) return json(await approvals.undo(record.id, callId, { by }));
      if (method === 'POST' && action === 'send' && parts.length === 2) return json(await approvals.send(record.id, { by }));
      if (method === 'POST' && action === 'retry' && parts.length === 2) return json(await approvals.retry(record.id, { by }));
      return fail(404, 'not_found', 'Unknown route.');
    } catch (e) {
      if (e && typeof e.status === 'number' && e.code) return fail(e.status, e.code, e.message);
      console.error('[hibira-approvals]', e);
      return fail(500, 'server_error', 'Something went wrong.');
    }
  };
}

/** Adapts a fetch handler to (req, res) for Express and node:http. */
export function nodeHandler(handle) {
  return async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const host = req.headers.host ?? 'localhost';
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    const method = req.method ?? 'GET';
    const request = new Request(`http://${host}${req.originalUrl ?? req.url}`, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
    });
    request.raw = req;
    const response = await handle(request);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

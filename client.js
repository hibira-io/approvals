// Browser side of the protocol, without a UI framework: talks to the app's
// approvals routes (PROTOCOL.md) and listens on the scope's channels with a
// pusher-js instance whose channel authorization points at `{endpoint}/auth`.
// The React and Vue components are built on it.

const INBOX = (scope) => `private-hibira-approvals.${scope}.inbox`;
const REVIEWERS = (scope) => `presence-hibira-approvals.${scope}.reviewers`;
const REQUEST = (scope, id) => `presence-hibira-approvals.${scope}.request.${id}`;

export class ApprovalsHttpError extends Error {
  constructor(status, code, message) {
    super(message || code || `HTTP ${status}`);
    this.name = 'ApprovalsHttpError';
    this.status = status;
    this.code = code;
  }
}

function membersOf(channel) {
  const list = [];
  channel.members?.each?.((m) => list.push({ id: String(m.id), ...(m.info ?? {}) }));
  return list;
}

/**
 * @param {{ endpoint: string, pusher?: any, scope?: string, fetch?: typeof fetch,
 *   headers?: Record<string, string> | (() => Record<string, string>) }} options
 */
export function createApprovalsClient(options) {
  if (!options?.endpoint) throw new TypeError('createApprovalsClient() needs an endpoint.');
  const base = options.endpoint.replace(/\/+$/, '');
  const scope = options.scope ?? 'default';
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const refs = new Map();

  async function call(method, path = '', body) {
    const extra = typeof options.headers === 'function' ? options.headers() : options.headers ?? {};
    const res = await doFetch(base + path, {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApprovalsHttpError(res.status, data.error, data.message);
    return data;
  }

  function join(name) {
    const ref = refs.get(name);
    if (ref) {
      ref.count++;
      return ref.channel;
    }
    const channel = options.pusher.subscribe(name);
    refs.set(name, { channel, count: 1 });
    return channel;
  }

  function leave(name) {
    const ref = refs.get(name);
    if (!ref || --ref.count > 0) return;
    refs.delete(name);
    options.pusher.unsubscribe(name);
  }

  function watchMembers(name, onMembers) {
    if (!options.pusher) return () => {};
    const channel = join(name);
    const update = () => onMembers(membersOf(channel));
    channel.bind('pusher:subscription_succeeded', update);
    channel.bind('pusher:member_added', update);
    channel.bind('pusher:member_removed', update);
    if (channel.subscribed) update();
    return () => {
      channel.unbind('pusher:subscription_succeeded', update);
      channel.unbind('pusher:member_added', update);
      channel.unbind('pusher:member_removed', update);
      leave(name);
    };
  }

  return {
    scope,
    endpoint: base,
    list: (status = 'pending') => call('GET', `?status=${encodeURIComponent(status)}`).then((r) => r.data),
    get: (id) => call('GET', `/${encodeURIComponent(id)}`),
    decide: (id, decisions, opts = {}) =>
      call('POST', `/${encodeURIComponent(id)}/decisions`, { decisions, ...(opts.send ? { send: true } : {}) }),
    undo: (id, callId) => call('DELETE', `/${encodeURIComponent(id)}/decisions/${encodeURIComponent(callId)}`),
    send: (id) => call('POST', `/${encodeURIComponent(id)}/send`),
    retry: (id) => call('POST', `/${encodeURIComponent(id)}/retry`),

    /** Calls `onEvent` with every `approval` event of the scope. */
    subscribe(onEvent) {
      if (!options.pusher) return () => {};
      const name = INBOX(scope);
      const channel = join(name);
      channel.bind('approval', onEvent);
      return () => {
        channel.unbind('approval', onEvent);
        leave(name);
      };
    },
    /** Reviewers who have an inbox open. */
    watchReviewers: (onMembers) => watchMembers(REVIEWERS(scope), onMembers),
    /** Reviewers looking at one request. */
    watchRequest: (id, onMembers) => watchMembers(REQUEST(scope, id), onMembers),
  };
}

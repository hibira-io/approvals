// Server side of the Hibira approvals protocol (see PROTOCOL.md): keep
// requests in a store, announce every change on the scope's inbox channel,
// and resume the agent once reviewers have decided.
//
// `pusher` is an instance of the `pusher` npm package pointed at Hibira, or
// any object with the same trigger() and authorizeChannel() methods.

import { randomBytes } from 'node:crypto';
import { createHandler } from './handler.js';

export const PROTOCOL_VERSION = 1;
export const EVENT = 'approval';
export const DECISIONS = ['approve', 'reject', 'edit'];
export const STATUSES = ['pending', 'approved', 'rejected', 'resuming', 'resumed', 'failed', 'resolved', 'expired'];
const DONE = ['approved', 'rejected', 'resumed', 'failed', 'resolved', 'expired'];
const SCOPE = /^[A-Za-z0-9_-]{1,64}$/;

export const channels = {
  inbox: (scope) => `private-hibira-approvals.${scope}.inbox`,
  reviewers: (scope) => `presence-hibira-approvals.${scope}.reviewers`,
  request: (scope, id) => `presence-hibira-approvals.${scope}.request.${id}`,
};

export class ApprovalError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
    this.status = status;
  }
}

let lastTime = 0;
let sequence = 0;

/** Time-ordered ids (within one process, strictly), so sorting by id is sorting by age. */
export function approvalId() {
  const time = Date.now();
  sequence = time === lastTime ? sequence + 1 : 0;
  lastTime = time;
  return 'apr_' + time.toString(36).padStart(9, '0') + sequence.toString(36).padStart(3, '0') + randomBytes(6).toString('hex');
}

/**
 * Keeps requests in memory: fine for development and single-process apps.
 * Anything else implements the same four methods on its own database;
 * update() must be atomic (a transaction with a row lock, Redis WATCH...).
 */
export function memoryStore() {
  const rows = new Map();
  const copy = (r) => (r == null ? null : structuredClone(r));
  return {
    async create(record) {
      rows.set(record.id, copy(record));
      return copy(record);
    },
    async get(id) {
      return copy(rows.get(id));
    },
    async list({ scope, statuses, limit = 50 }) {
      return [...rows.values()]
        .filter((r) => r.scope === scope && (!statuses || statuses.includes(r.status)))
        .sort((a, b) => (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map(copy);
    },
    async update(id, fn) {
      const current = rows.get(id);
      if (!current) return null;
      const next = fn(copy(current));
      if (next == null) return null;
      rows.set(id, copy(next));
      return copy(next);
    },
  };
}

/**
 * @param {object} options
 * @param {{ trigger: Function, authorizeChannel?: Function }} [options.pusher]
 * @param {string} [options.scope]
 * @param {ReturnType<typeof memoryStore>} [options.store]
 * @param {(request: object) => unknown | Promise<unknown>} [options.resume]
 * @param {(request: object) => unknown | Promise<unknown>} [options.notify]
 * @param {(request: object) => string | null} [options.url]
 * @param {(error: unknown) => void} [options.onError]
 */
export function createApprovals(options = {}) {
  const scope = options.scope ?? 'default';
  if (!SCOPE.test(scope)) throw new TypeError(`Scope "${scope}" may only use letters, digits, - and _.`);
  const store = options.store ?? memoryStore();
  const onError = options.onError ?? ((e) => console.error('[hibira-approvals]', e));
  const now = () => new Date().toISOString();

  async function publish(record, reason, by = null) {
    if (!options.pusher) return;
    try {
      await options.pusher.trigger(channels.inbox(scope), EVENT, {
        v: PROTOCOL_VERSION,
        id: record.id,
        reason,
        status: record.status,
        agent: record.agent,
        title: record.title,
        tools: [...new Set(record.calls.map((c) => c.tool))],
        by,
        url: record.url,
        expires_at: record.expires_at,
      });
    } catch (e) {
      onError(e);
    }
  }

  async function load(id) {
    let record = await store.get(id);
    if (!record || record.scope !== scope) throw new ApprovalError('not_found', `No approval request ${id}.`, 404);
    if (record.status === 'pending' && record.expires_at && Date.parse(record.expires_at) <= Date.now()) {
      const expired = await store.update(id, (r) => (r.status === 'pending' ? { ...r, status: 'expired', finished_at: now() } : null));
      if (expired) {
        record = expired;
        await publish(record, 'expired');
      } else {
        record = await store.get(id);
      }
    }
    return record;
  }

  function pendingOnly(r) {
    if (r.status !== 'pending') throw new ApprovalError('not_pending', `Request ${r.id} is ${r.status}.`);
  }

  async function finish(id, by) {
    const record = await store.get(id);
    if (!options.resume) {
      const done = await store.update(id, (r) => ({ ...r, status: 'resumed', finished_at: now() }));
      await publish(done, 'resumed', by);
      return done;
    }
    try {
      await options.resume(record);
      const done = await store.update(id, (r) => ({ ...r, status: 'resumed', finished_at: now(), error: null }));
      await publish(done, 'resumed', by);
      return done;
    } catch (e) {
      onError(e);
      const message = String(e?.message ?? e).slice(0, 2000);
      const failed = await store.update(id, (r) => ({ ...r, status: 'failed', finished_at: now(), error: message }));
      await publish(failed, 'failed', by);
      return failed;
    }
  }

  const approvals = {
    scope,
    store,
    channels: {
      inbox: channels.inbox(scope),
      reviewers: channels.reviewers(scope),
      request: (id) => channels.request(scope, id),
    },

    /**
     * Opens a request for one or more tool calls and tells the reviewers.
     * @param {{ calls: { id?: string, tool: string, input?: unknown }[], agent?: string, title?: string,
     *   metadata?: object, expiresIn?: number, id?: string }} input
     */
    async request(input) {
      const calls = input?.calls ?? [];
      if (!Array.isArray(calls) || calls.length === 0) throw new TypeError('request() needs at least one call.');
      const record = {
        id: input.id ?? approvalId(),
        scope,
        agent: input.agent ?? 'agent',
        title: input.title ?? null,
        status: 'pending',
        created_at: now(),
        expires_at: input.expiresIn ? new Date(Date.now() + input.expiresIn).toISOString() : null,
        decided_at: null,
        finished_at: null,
        error: null,
        url: null,
        metadata: input.metadata ?? {},
        calls: calls.map((c, i) => {
          if (!c || typeof c.tool !== 'string') throw new TypeError(`Call ${i} needs a tool name.`);
          return {
            id: String(c.id ?? `call_${i + 1}`),
            tool: c.tool,
            input: c.input ?? null,
            decision: null,
            edited_input: null,
            reason: null,
            decided_by: null,
            decided_at: null,
          };
        }),
      };
      if (new Set(record.calls.map((c) => c.id)).size !== record.calls.length) throw new TypeError('Call ids must be unique.');
      record.url = options.url?.(record) ?? null;
      const saved = await store.create(record);
      await publish(saved, 'requested');
      if (options.notify) {
        try {
          await options.notify(saved);
        } catch (e) {
          onError(e);
        }
      }
      return saved;
    },

    get: load,

    /** @param {{ status?: 'pending' | 'done' | 'all', limit?: number }} [filter] */
    async list(filter = {}) {
      const status = filter.status ?? 'pending';
      const statuses = status === 'all' ? null : status === 'done' ? DONE : ['pending', 'resuming'];
      return store.list({ scope, statuses, limit: filter.limit ?? 50 });
    },

    /**
     * Saves decisions for some or all calls. With `send`, resumes once every
     * call has one.
     * @param {string} id
     * @param {Record<string, { decision: 'approve' | 'reject' | 'edit', input?: unknown, reason?: string }>} decisions
     * @param {{ by?: string, send?: boolean }} [opts]
     */
    async decide(id, decisions, opts = {}) {
      const by = opts.by ?? null;
      const current = await load(id);
      pendingOnly(current);
      const entries = Object.entries(decisions ?? {});
      if (entries.length === 0) throw new ApprovalError('bad_request', 'No decisions given.', 400);
      for (const [callId, d] of entries) {
        if (!current.calls.some((c) => c.id === callId)) throw new ApprovalError('bad_request', `Unknown call ${callId}.`, 400);
        if (!DECISIONS.includes(d?.decision)) throw new ApprovalError('bad_request', `Unknown decision "${d?.decision}".`, 400);
        if (d.decision === 'edit' && d.input === undefined) throw new ApprovalError('bad_request', 'An edit needs the new input.', 400);
      }
      const at = now();
      const saved = await store.update(id, (r) => {
        if (r.status !== 'pending') return null;
        r.calls = r.calls.map((c) => {
          const d = decisions[c.id];
          if (!d) return c;
          return {
            ...c,
            decision: d.decision,
            edited_input: d.decision === 'edit' ? d.input : null,
            reason: d.decision === 'reject' && d.reason ? String(d.reason).slice(0, 2000) : null,
            decided_by: by,
            decided_at: at,
          };
        });
        r.decided_at = at;
        return r;
      });
      if (!saved) throw new ApprovalError('not_pending', `Request ${id} is no longer pending.`);
      await publish(saved, 'decided', by);
      return opts.send ? approvals.send(id, { by }) : saved;
    },

    /** Takes one decision back while the request still waits. */
    async undo(id, callId, opts = {}) {
      const current = await load(id);
      pendingOnly(current);
      const saved = await store.update(id, (r) => {
        if (r.status !== 'pending') return null;
        r.calls = r.calls.map((c) =>
          c.id === callId ? { ...c, decision: null, edited_input: null, reason: null, decided_by: null, decided_at: null } : c,
        );
        return r;
      });
      if (!saved) throw new ApprovalError('not_pending', `Request ${id} is no longer pending.`);
      await publish(saved, 'decided', opts.by ?? null);
      return saved;
    },

    /** Resumes the agent once every call is decided. Runs once. */
    async send(id, opts = {}) {
      const current = await load(id);
      pendingOnly(current);
      if (current.calls.some((c) => !c.decision)) throw new ApprovalError('undecided', 'Every call needs a decision first.');
      const claimed = await store.update(id, (r) =>
        r.status === 'pending' && r.calls.every((c) => c.decision) ? { ...r, status: 'resuming' } : null,
      );
      if (!claimed) throw new ApprovalError('not_pending', `Request ${id} is no longer pending.`);
      await publish(claimed, 'resuming', opts.by ?? null);
      return finish(id, opts.by ?? null);
    },

    /** Resumes a failed request again. */
    async retry(id, opts = {}) {
      await load(id);
      const claimed = await store.update(id, (r) => (r.status === 'failed' ? { ...r, status: 'resuming', error: null } : null));
      if (!claimed) throw new ApprovalError('not_failed', `Request ${id} has not failed.`);
      await publish(claimed, 'resuming', opts.by ?? null);
      return finish(id, opts.by ?? null);
    },

    /** Marks a request as answered somewhere else, such as the app's own chat. */
    async resolve(id) {
      await load(id);
      const saved = await store.update(id, (r) =>
        r.status === 'pending' || r.status === 'failed' ? { ...r, status: 'resolved', finished_at: now() } : null,
      );
      if (saved) await publish(saved, 'resolved');
      return saved ?? store.get(id);
    },

    /** Expires overdue pending requests; run it from a cron if nobody opens them. */
    async expire() {
      const pending = await store.list({ scope, statuses: ['pending'], limit: 1000 });
      let count = 0;
      for (const r of pending) {
        if (r.expires_at && Date.parse(r.expires_at) <= Date.now()) {
          const after = await load(r.id);
          if (after.status === 'expired') count++;
        }
      }
      return count;
    },

    /**
     * Waits until the request leaves `pending`/`resuming`, polling the
     * store. For long-lived workers that keep the agent waiting in place.
     */
    async wait(id, { interval = 1000, timeout, signal } = {}) {
      const deadline = timeout ? Date.now() + timeout : Infinity;
      for (;;) {
        const r = await load(id);
        if (r.status !== 'pending' && r.status !== 'resuming') return r;
        if (r.status === 'resuming' && !options.resume) return r;
        if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
        if (Date.now() >= deadline) throw new ApprovalError('timeout', `Timed out waiting for ${id}.`, 408);
        await new Promise((res) => setTimeout(res, interval));
      }
    },

    /**
     * Pusher channel authorization for this scope's channels. Returns null
     * for any other channel.
     */
    authorize(socketId, channel, user) {
      const ok =
        channel === channels.inbox(scope) ||
        channel === channels.reviewers(scope) ||
        channel.startsWith(`presence-hibira-approvals.${scope}.request.`);
      if (!ok || !options.pusher?.authorizeChannel) return null;
      if (channel.startsWith('presence-')) {
        return options.pusher.authorizeChannel(socketId, channel, {
          user_id: String(user.id),
          user_info: { name: user.name ?? String(user.id), ...(user.avatar ? { avatar: user.avatar } : {}) },
        });
      }
      return options.pusher.authorizeChannel(socketId, channel);
    },

    /** Web-standard fetch handler for the HTTP API in PROTOCOL.md. */
    handler(handlerOptions) {
      return createHandler(approvals, handlerOptions);
    },
  };

  return approvals;
}

export { createHandler, nodeHandler } from './handler.js';

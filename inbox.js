// State behind the inbox and card components, shared by React and Vue: the
// request list, the open request, who else is looking, and the reviewer's
// unsaved edits. Framework code subscribes and re-renders on change.

export function createInbox(client, options = {}) {
  const listeners = new Set();
  let state = {
    status: options.status ?? 'pending',
    requests: [],
    loading: true,
    error: null,
    activeId: options.id ?? null,
    active: null,
    viewers: [],
    reviewers: [],
    busy: false,
    actionError: null,
    editing: null,
    rejecting: null,
  };
  let stopRequest = () => {};
  let destroyed = false;
  let listSeq = 0;
  let activeSeq = 0;
  const single = options.id != null;

  const set = (patch) => {
    if (destroyed) return;
    state = { ...state, ...patch };
    for (const l of listeners) l(state);
  };

  async function loadList() {
    if (single) return;
    const seq = ++listSeq;
    try {
      const requests = await client.list(state.status);
      if (seq === listSeq) set({ requests, loading: false, error: null });
    } catch (e) {
      if (seq === listSeq) set({ loading: false, error: e });
    }
  }

  async function loadActive() {
    const id = state.activeId;
    if (!id) return;
    const seq = ++activeSeq;
    try {
      const active = await client.get(id);
      if (seq === activeSeq && state.activeId === id) set({ active, loading: false, error: null });
    } catch (e) {
      if (seq === activeSeq) set({ loading: false, error: e });
    }
  }

  function watch(id) {
    stopRequest();
    stopRequest = id ? client.watchRequest(id, (viewers) => set({ viewers })) : () => {};
  }

  const stopInbox = client.subscribe((event) => {
    loadList();
    if (event?.id && event.id === state.activeId) loadActive();
  });
  const stopReviewers = single ? () => {} : client.watchReviewers((reviewers) => set({ reviewers }));

  async function act(fn) {
    if (state.busy) return;
    set({ busy: true, actionError: null });
    try {
      const active = await fn();
      if (active && active.id === state.activeId) set({ active });
      loadList();
    } catch (e) {
      set({ actionError: e });
      loadActive();
    } finally {
      set({ busy: false });
    }
  }

  const id = () => state.activeId;

  const inbox = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: () => Promise.all([loadList(), loadActive()]),
    setStatus(status) {
      set({ status, loading: true });
      loadList();
    },
    open(requestId) {
      set({ activeId: requestId, active: null, viewers: [], editing: null, rejecting: null, actionError: null });
      watch(requestId);
      loadActive();
    },
    close() {
      if (single) return;
      watch(null);
      set({ activeId: null, active: null, viewers: [], editing: null, rejecting: null, actionError: null });
    },
    decide: (callId, decision, extra = {}) =>
      act(() => client.decide(id(), { [callId]: { decision, ...extra } })).then(() => set({ editing: null, rejecting: null })),
    undo: (callId) => act(() => client.undo(id(), callId)),
    decideAll(decision) {
      const calls = state.active?.calls ?? [];
      const decisions = Object.fromEntries(calls.filter((c) => !c.decision).map((c) => [c.id, { decision }]));
      return act(() => client.decide(id(), decisions, { send: true }));
    },
    send: () => act(() => client.send(id())),
    retry: () => act(() => client.retry(id())),
    startEdit(call) {
      set({ editing: { callId: call.id, text: JSON.stringify(call.input ?? {}, null, 2), invalid: false }, rejecting: null });
    },
    setEditText: (text) => set({ editing: state.editing && { ...state.editing, text, invalid: false } }),
    saveEdit() {
      const e = state.editing;
      if (!e) return;
      let input;
      try {
        input = JSON.parse(e.text);
      } catch {
        set({ editing: { ...e, invalid: true } });
        return;
      }
      return inbox.decide(e.callId, 'edit', { input });
    },
    startReject: (call) => set({ rejecting: { callId: call.id, text: '' }, editing: null }),
    setRejectText: (text) => set({ rejecting: state.rejecting && { ...state.rejecting, text } }),
    saveReject() {
      const r = state.rejecting;
      if (!r) return;
      return inbox.decide(r.callId, 'reject', r.text.trim() ? { reason: r.text.trim() } : {});
    },
    cancelForm: () => set({ editing: null, rejecting: null }),
    destroy() {
      destroyed = true;
      stopInbox();
      stopReviewers();
      stopRequest();
      listeners.clear();
    },
  };

  if (single) {
    watch(state.activeId);
    loadActive();
  } else {
    loadList();
    if (state.activeId) inbox.open(state.activeId);
  }
  return inbox;
}

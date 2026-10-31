import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://app.test/' });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'SVGElement', 'Element', 'MutationObserver']) {
  Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createApprovals } = await import('../index.js');
const { createApprovalsClient } = await import('../client.js');

/** A pusher-js stand-in wired to the server's fake trigger(). */
function fakeBus() {
  const channels = new Map();
  const channel = (name) => {
    if (!channels.has(name)) {
      const handlers = new Map();
      channels.set(name, {
        subscribed: true,
        members: { each: (fn) => fn({ id: '2', info: { name: 'Bo Chen' } }) },
        bind: (e, fn) => handlers.set(e, [...(handlers.get(e) ?? []), fn]),
        unbind: (e, fn) => handlers.set(e, (handlers.get(e) ?? []).filter((f) => f !== fn)),
        emit: (e, d) => (handlers.get(e) ?? []).forEach((f) => f(d)),
      });
    }
    return channels.get(name);
  };
  return {
    pusher: { subscribe: channel, unsubscribe: (n) => channels.delete(n) },
    server: { trigger: (name, e, d) => channels.get(name)?.emit(e, d) },
  };
}

async function world() {
  const bus = fakeBus();
  const approvals = createApprovals({ pusher: bus.server });
  const handle = approvals.handler({ basePath: '/api/approvals', getUser: () => ({ id: '1', name: 'Ann' }) });
  const client = createApprovalsClient({
    endpoint: '/api/approvals',
    pusher: bus.pusher,
    fetch: (url, init) => handle(new Request(new URL(url, 'http://app.test'), init)),
  });
  const r = await approvals.request({
    agent: 'Support agent',
    title: 'Refund order #1042',
    calls: [
      { id: 'a', tool: 'refund_order', input: { order: 1042 } },
      { id: 'b', tool: 'send_email', input: { to: 'ann@example.com' } },
    ],
  });
  return { approvals, client, r };
}

const tick = () => new Promise((res) => setTimeout(res, 10));
const buttons = (root, text) => [...root.querySelectorAll('button')].filter((b) => b.textContent.trim() === text);

test('React inbox: open, approve one, approve the rest, send', async () => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const { ApprovalInbox } = await import('../react.js');
  const { approvals, client, r } = await world();
  const root = document.createElement('div');
  document.body.append(root);
  const app = createRoot(root);
  await act(async () => app.render(React.createElement(ApprovalInbox, { client, me: '1' })));
  await act(tick);
  assert.match(root.textContent, /Refund order #1042/);
  await act(async () => root.querySelector('.hb-ap-row').click());
  await act(tick);
  assert.match(root.querySelector('.hb-ap-input').textContent, /1042/);
  assert.ok(root.querySelector('.hb-ap-card .hb-ap-people'), 'shows who else is looking');
  await act(async () => buttons(root, 'Approve')[0].click());
  await act(tick);
  assert.equal((await approvals.get(r.id)).calls[0].decision, 'approve');
  assert.match(root.textContent, /by Ann/);
  await act(async () => buttons(root, 'Approve all')[0].click());
  await act(tick);
  assert.equal((await approvals.get(r.id)).status, 'resumed');
  assert.match(root.querySelector('.hb-ap-card .hb-ap-badge').textContent, /Done/);
  await act(async () => app.unmount());
});

test('React card: edit with bad JSON, then reject with a reason, in Japanese', async () => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const { ApprovalCard } = await import('../react.js');
  const { approvals, client, r } = await world();
  const root = document.createElement('div');
  const app = createRoot(root);
  await act(async () => app.render(React.createElement(ApprovalCard, { client, id: r.id, locale: 'ja' })));
  await act(tick);
  await act(async () => buttons(root, '編集')[0].click());
  const area = root.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  await act(async () => {
    setter.call(area, '{oops');
    area.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => buttons(root, '変更して承認')[0].click());
  assert.match(root.textContent, /有効な JSON ではありません/);
  await act(async () => {
    setter.call(area, '{"order": 7}');
    area.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => buttons(root, '変更して承認')[0].click());
  await act(tick);
  assert.deepEqual((await approvals.get(r.id)).calls[0].edited_input, { order: 7 });
  await act(async () => buttons(root, '却下')[0].click());
  const reason = root.querySelector('textarea');
  await act(async () => {
    setter.call(reason, 'Wrong address');
    reason.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => buttons(root, '却下').at(-1).click());
  await act(tick);
  assert.equal((await approvals.get(r.id)).calls[1].reason, 'Wrong address');
  assert.ok(buttons(root, 'AI に返す').length, 'send appears once all are decided');
  await act(async () => app.unmount());
});

test('Vue inbox and card', async () => {
  const { createApp, h, nextTick } = await import('vue');
  const { ApprovalInbox, ApprovalCard } = await import('../vue.js');
  const { approvals, client, r } = await world();
  const root = document.createElement('div');
  const app = createApp({ render: () => h(ApprovalInbox, { client, locale: 'zh-TW' }) });
  app.mount(root);
  await tick();
  await nextTick();
  assert.match(root.textContent, /Refund order #1042/);
  root.querySelector('.hb-ap-row').click();
  await tick();
  await nextTick();
  buttons(root, '全部核准')[0].click();
  await tick();
  await nextTick();
  assert.equal((await approvals.get(r.id)).status, 'resumed');
  app.unmount();

  const other = await approvals.request({ calls: [{ id: 'x', tool: 'delete_user', input: { id: 9 } }] });
  const root2 = document.createElement('div');
  const card = createApp({ render: () => h(ApprovalCard, { client, id: other.id }) });
  card.mount(root2);
  await tick();
  await nextTick();
  assert.match(root2.textContent, /delete_user/);
  assert.equal(root2.querySelector('svg path')?.namespaceURI, 'http://www.w3.org/2000/svg');
  buttons(root2, 'Approve')[0].click();
  await tick();
  await nextTick();
  assert.ok(buttons(root2, 'Send to agent').length);
  card.unmount();
});

test('live update: another reviewer decides', async () => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const { ApprovalCard } = await import('../react.js');
  const { approvals, client, r } = await world();
  const root = document.createElement('div');
  const app = createRoot(root);
  await act(async () => app.render(React.createElement(ApprovalCard, { client, id: r.id })));
  await act(tick);
  await act(async () => {
    await approvals.decide(r.id, { a: { decision: 'reject', reason: 'Fraud' } }, { by: 'Bo' });
    await tick();
  });
  assert.match(root.textContent, /Fraud/);
  assert.match(root.textContent, /by Bo/);
  await act(async () => app.unmount());
});

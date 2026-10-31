import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovals, channels, ApprovalError } from '../index.js';
import { fakePusher } from './helpers.mjs';

const calls = [
  { id: 'a', tool: 'refund_order', input: { order: 1042, amount: 120 } },
  { id: 'b', tool: 'send_email', input: { to: 'ann@example.com' } },
];

test('request announces on the inbox channel without tool input', async () => {
  const pusher = fakePusher();
  const approvals = createApprovals({ pusher, scope: 'support' });
  const r = await approvals.request({ agent: 'Support agent', title: 'Refund #1042', calls });
  assert.match(r.id, /^apr_/);
  assert.equal(r.status, 'pending');
  assert.equal(pusher.events.length, 1);
  const [e] = pusher.events;
  assert.equal(e.channel, 'private-hibira-approvals.support.inbox');
  assert.equal(e.event, 'approval');
  assert.deepEqual(e.data.tools, ['refund_order', 'send_email']);
  assert.equal(e.data.reason, 'requested');
  assert.equal(e.data.v, 1);
  assert.ok(!('calls' in e.data));
  assert.ok(Buffer.byteLength(JSON.stringify(e.data)) < 4096);
});

test('decide, send and resume once', async () => {
  const pusher = fakePusher();
  const resumed = [];
  const approvals = createApprovals({ pusher, resume: (r) => resumed.push(r) });
  const r = await approvals.request({ calls });
  await approvals.decide(r.id, { a: { decision: 'approve' } }, { by: 'Ann' });
  await assert.rejects(approvals.send(r.id), (e) => e instanceof ApprovalError && e.code === 'undecided');
  const done = await approvals.decide(r.id, { b: { decision: 'reject', reason: 'Wrong customer' } }, { by: 'Bo', send: true });
  assert.equal(done.status, 'resumed');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].calls[1].reason, 'Wrong customer');
  assert.equal(resumed[0].calls[0].decided_by, 'Ann');
  assert.deepEqual(
    pusher.events.map((e) => e.data.reason),
    ['requested', 'decided', 'decided', 'resuming', 'resumed'],
  );
  await assert.rejects(approvals.send(r.id), (e) => e.code === 'not_pending');
});

test('concurrent sends resume only once', async () => {
  let n = 0;
  const approvals = createApprovals({ resume: async () => n++ });
  const r = await approvals.request({ calls: [calls[0]] });
  await approvals.decide(r.id, { a: { decision: 'approve' } });
  const results = await Promise.allSettled([approvals.send(r.id), approvals.send(r.id), approvals.send(r.id)]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(n, 1);
});

test('edit needs input; undo clears a decision', async () => {
  const approvals = createApprovals();
  const r = await approvals.request({ calls });
  await assert.rejects(approvals.decide(r.id, { a: { decision: 'edit' } }), (e) => e.status === 400);
  await assert.rejects(approvals.decide(r.id, { zzz: { decision: 'approve' } }), (e) => e.status === 400);
  await assert.rejects(approvals.decide(r.id, { a: { decision: 'maybe' } }), (e) => e.status === 400);
  const edited = await approvals.decide(r.id, { a: { decision: 'edit', input: { order: 1042, amount: 60 } } });
  assert.deepEqual(edited.calls[0].edited_input, { order: 1042, amount: 60 });
  const undone = await approvals.undo(r.id, 'a');
  assert.equal(undone.calls[0].decision, null);
  assert.equal(undone.calls[0].edited_input, null);
});

test('failed resume can be retried', async () => {
  let fail = true;
  const pusher = fakePusher();
  const approvals = createApprovals({
    pusher,
    onError: () => {},
    resume: () => {
      if (fail) throw new Error('model down');
    },
  });
  const r = await approvals.request({ calls: [calls[0]] });
  const failed = await approvals.decide(r.id, { a: { decision: 'approve' } }, { send: true });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'model down');
  fail = false;
  const ok = await approvals.retry(r.id);
  assert.equal(ok.status, 'resumed');
  assert.equal(ok.error, null);
  await assert.rejects(approvals.retry(r.id), (e) => e.code === 'not_failed');
});

test('expiry, resolve, list filters and scopes', async () => {
  const approvals = createApprovals();
  const other = createApprovals({ store: approvals.store, scope: 'other' });
  const old = await approvals.request({ calls, expiresIn: 1 });
  const open = await approvals.request({ calls });
  const answered = await approvals.request({ calls });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await approvals.get(old.id)).status, 'expired');
  await assert.rejects(approvals.decide(old.id, { a: { decision: 'approve' } }), (e) => e.code === 'not_pending');
  await approvals.resolve(answered.id);
  assert.deepEqual((await approvals.list()).map((r) => r.id), [open.id]);
  assert.deepEqual((await approvals.list({ status: 'done' })).map((r) => r.id), [answered.id, old.id]);
  assert.equal((await approvals.list({ status: 'all' })).length, 3);
  await assert.rejects(other.get(open.id), (e) => e.status === 404);
  assert.equal((await other.list({ status: 'all' })).length, 0);
});

test('wait returns once decided', async () => {
  const approvals = createApprovals();
  const r = await approvals.request({ calls: [calls[0]] });
  setTimeout(() => approvals.decide(r.id, { a: { decision: 'approve' } }, { send: true }), 20);
  const done = await approvals.wait(r.id, { interval: 5, timeout: 2000 });
  assert.equal(done.status, 'resumed');
  await assert.rejects(
    approvals.wait((await approvals.request({ calls })).id, { interval: 5, timeout: 20 }),
    (e) => e.code === 'timeout',
  );
});

test('authorize only this scope', () => {
  const approvals = createApprovals({ pusher: fakePusher(), scope: 'ops' });
  const me = { id: 7, name: 'Ann' };
  assert.ok(approvals.authorize('1.2', channels.inbox('ops'), me).auth);
  const presence = approvals.authorize('1.2', channels.request('ops', 'apr_x'), me);
  assert.deepEqual(JSON.parse(presence.channel_data), { user_id: '7', user_info: { name: 'Ann' } });
  assert.equal(approvals.authorize('1.2', channels.inbox('sales'), me), null);
  assert.equal(approvals.authorize('1.2', 'private-orders', me), null);
});

test('bad input', async () => {
  assert.throws(() => createApprovals({ scope: 'a.b' }));
  const approvals = createApprovals();
  await assert.rejects(approvals.request({ calls: [] }));
  await assert.rejects(approvals.request({ calls: [{ id: 'x', tool: 't' }, { id: 'x', tool: 't' }] }));
  await assert.rejects(approvals.get('apr_missing'), (e) => e.status === 404);
});

test('a broken pusher does not break the flow', async () => {
  const errors = [];
  const approvals = createApprovals({
    pusher: { trigger: () => Promise.reject(new Error('offline')) },
    onError: (e) => errors.push(e),
  });
  const r = await approvals.request({ calls: [calls[0]] });
  assert.equal(r.status, 'pending');
  assert.equal(errors.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApprovals, nodeHandler } from '../index.js';
import { fakePusher } from './helpers.mjs';

function setup(opts = {}) {
  const approvals = createApprovals({ pusher: fakePusher(), ...opts });
  const handle = approvals.handler({
    basePath: '/api/approvals',
    getUser: (req) => (req.headers.get('x-user') ? { id: req.headers.get('x-user'), name: `User ${req.headers.get('x-user')}` } : null),
    canReview: (user, r) => user.id !== 'guest' && !(r?.metadata?.private && user.id !== '1'),
  });
  const call = async (method, path, body, user = '1') => {
    const res = await handle(
      new Request(`http://app.test/api/approvals${path}`, {
        method,
        headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    return { status: res.status, body: await res.json() };
  };
  return { approvals, call };
}

test('routes', async () => {
  const { approvals, call } = setup();
  const r = await approvals.request({ calls: [{ id: 'a', tool: 'refund', input: { n: 1 } }, { id: 'b', tool: 'email' }] });

  assert.equal((await call('GET', '', null, null)).status, 401);
  assert.equal((await call('GET', '', null, 'guest')).status, 403);
  assert.deepEqual((await call('GET', '?status=pending')).body.data.map((x) => x.id), [r.id]);
  assert.equal((await call('GET', '?status=nope')).status, 400);
  assert.equal((await call('GET', `/${r.id}`)).body.calls[0].input.n, 1);
  assert.equal((await call('GET', '/apr_nope')).status, 404);

  let res = await call('POST', `/${r.id}/decisions`, { decisions: { a: { decision: 'approve' } } });
  assert.equal(res.body.calls[0].decided_by, 'User 1');
  res = await call('POST', `/${r.id}/send`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'undecided');
  res = await call('DELETE', `/${r.id}/decisions/a`);
  assert.equal(res.body.calls[0].decision, null);
  res = await call('POST', `/${r.id}/decisions`, { decisions: { a: { decision: 'approve' }, b: { decision: 'reject', reason: 'no' } }, send: true });
  assert.equal(res.body.status, 'resumed');
  assert.equal((await call('POST', `/${r.id}/retry`)).body.error, 'not_failed');
  assert.equal((await call('PUT', `/${r.id}`)).status, 404);
});

test('canReview per request', async () => {
  const { approvals, call } = setup();
  await approvals.request({ calls: [{ tool: 'a' }] });
  const secret = await approvals.request({ calls: [{ tool: 'b' }], metadata: { private: true } });
  assert.equal((await call('GET', '', null, '2')).body.data.length, 1);
  assert.equal((await call('GET', `/${secret.id}`, null, '2')).status, 403);
  assert.equal((await call('GET', `/${secret.id}`, null, '1')).status, 200);
});

test('channel auth route with a form body', async () => {
  const { approvals } = setup();
  const handle = approvals.handler({ getUser: () => ({ id: 3, name: 'Cy' }) });
  const res = await handle(
    new Request('http://app.test/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'socket_id=1.2&channel_name=presence-hibira-approvals.default.reviewers',
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(JSON.parse((await res.json()).channel_data).user_id, '3');
  const bad = await handle(
    new Request('http://app.test/auth', { method: 'POST', body: 'socket_id=1.2&channel_name=private-x', headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
  );
  assert.equal(bad.status, 403);
});

test('nodeHandler serves node:http', async () => {
  const { approvals } = setup();
  const r = await approvals.request({ calls: [{ id: 'a', tool: 'x' }] });
  const handle = approvals.handler({ basePath: '/approvals', getUser: (req) => ({ id: req.raw.headers['x-user'] ?? 'anon' }) });
  const server = http.createServer(nodeHandler(handle)).listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/approvals/${r.id}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'dee' },
      body: JSON.stringify({ decisions: { a: { decision: 'approve' } }, send: true }),
    });
    const body = await res.json();
    assert.equal(body.status, 'resumed');
    assert.equal(body.calls[0].decided_by, 'dee');
  } finally {
    server.close();
  }
});

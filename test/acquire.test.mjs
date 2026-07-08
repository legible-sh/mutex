// Mutex basics over real HTTP: acquire/renew/release/status, naming,
// fencing monotonicity, validation errors, content negotiation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, req } from './helpers.mjs';

test('mutex lifecycle: acquire, contend, release, reacquire', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  // Acquire a fresh topic.
  const a = await req('POST', `${url}/migrate-db?ttl=60`, { headers: { 'x-name': 'worker-1' } });
  assert.equal(a.status, 200);
  assert.match(a.json.lease, /^[0-9a-f]{32}$/);
  assert.equal(a.json.fence, 1);
  assert.equal(a.json.capacity, 1);
  assert.deepEqual(a.json.holders, ['worker-1']);
  assert.equal(a.json.name, 'worker-1');
  assert.ok(new Date(a.json.expires).getTime() > Date.now());
  assert.ok(a.json.renew.endsWith(`/migrate-db/${a.json.lease}/renew?ttl=60`));
  assert.ok(a.json.release.endsWith(`/migrate-db/${a.json.lease}`));

  // Second acquirer bounces with 409 and sees who holds it.
  const b = await req('POST', `${url}/migrate-db?ttl=60`, { headers: { 'x-name': 'worker-2' } });
  assert.equal(b.status, 409);
  assert.equal(b.json.code, 'BUSY');
  assert.deepEqual(b.json.holders, ['worker-1']);
  assert.equal(b.json.waiting, 0);
  assert.match(b.json.hint, /\?wait=/, 'a 409 teaches the caller how to queue');

  // Status shows the holder but never the lease token.
  const s = await req('GET', `${url}/migrate-db`);
  assert.equal(s.status, 200);
  assert.equal(s.json.capacity, 1);
  assert.equal(s.json.holders.length, 1);
  assert.equal(s.json.holders[0].name, 'worker-1');
  assert.equal(s.json.holders[0].fence, 1);
  assert.equal(s.json.waiting, 0);
  assert.ok(!s.text.includes(a.json.lease), 'lease token must never appear in status');

  // Release, then the loser can take it — with a higher fence.
  const r = await req('DELETE', `${url}/migrate-db/${a.json.lease}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.released, true);
  assert.equal(r.json.name, 'worker-1');

  const c = await req('POST', `${url}/migrate-db?ttl=60`, { headers: { 'x-name': 'worker-2' } });
  assert.equal(c.status, 200);
  assert.equal(c.json.fence, 2, 'fencing tokens are monotonic per topic');

  // Double release is a legible 404.
  const rr = await req('DELETE', `${url}/migrate-db/${a.json.lease}`);
  assert.equal(rr.status, 404);
  assert.equal(rr.json.code, 'NOT_FOUND');
  assert.match(rr.json.hint, /nothing to release/);
});

test('holder naming: X-Name, ?name=, plain-text body, anonymous fallback', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const viaQuery = await req('POST', `${url}/n1?name=query-worker`);
  assert.equal(viaQuery.json.name, 'query-worker');

  const viaBody = await req('POST', `${url}/n2`, { body: 'body-worker' });
  assert.equal(viaBody.json.name, 'body-worker');

  const anon = await req('POST', `${url}/n3`);
  assert.match(anon.json.name, /^anon-[0-9a-f]{6}$/);

  // X-Name wins over body.
  const both = await req('POST', `${url}/n4`, { headers: { 'x-name': 'header-worker' }, body: 'ignored' });
  assert.equal(both.json.name, 'header-worker');
});

test('validation: bad topics, bad params, oversized bodies, wrong methods', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const badTopic = await req('POST', `${url}/no%20spaces`);
  assert.equal(badTopic.status, 400);
  assert.equal(badTopic.json.code, 'BAD_TOPIC');

  const tooLong = await req('POST', `${url}/${'x'.repeat(65)}`);
  assert.equal(tooLong.status, 400);

  const badTtl = await req('POST', `${url}/t?ttl=999999`);
  assert.equal(badTtl.status, 400);
  assert.equal(badTtl.json.code, 'BAD_PARAM');

  const badWait = await req('POST', `${url}/t?wait=-5`);
  assert.equal(badWait.status, 400);

  const badCapacity = await req('POST', `${url}/t?capacity=0`);
  assert.equal(badCapacity.status, 400);

  const fatBody = await req('POST', `${url}/t`, { body: 'x'.repeat(5000) });
  assert.equal(fatBody.status, 413);
  assert.equal(fatBody.json.code, 'TOO_LARGE');
  assert.match(fatBody.json.hint, /X-Name/, 'a 413 points at the header alternative');

  const longName = await req('POST', `${url}/t`, { headers: { 'x-name': 'x'.repeat(200) } });
  assert.equal(longName.status, 400);

  const wrongMethod = await req('DELETE', `${url}/t`);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.code, 'METHOD_NOT_ALLOWED');
  assert.match(wrongMethod.json.hint, /DELETE \/\{topic\}\/\{lease\}/, 'a 405 spells out the right call');

  const noRoute = await req('GET', `${url}/t/x/y/z`);
  assert.equal(noRoute.status, 404);
  assert.match(noRoute.json.hint, /POST \/\{topic\}/, 'a 404 route error maps the API');

  // Renewing a lease that never existed.
  const ghost = await req('POST', `${url}/t/deadbeefdeadbeefdeadbeefdeadbeef/renew`);
  assert.equal(ghost.status, 404);
  assert.match(ghost.json.hint, /re-acquire/, 'a lost lease says how to start over');
});

test('content negotiation: curl gets text/JSON, browsers get HTML', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const help = await req('GET', url);
  assert.ok(help.headers.get('content-type').includes('text/plain'));
  assert.match(help.text, /flock\(1\) for agents/);
  assert.match(help.text, /renew/);

  const home = await req('GET', url, { headers: { accept: 'text/html' } });
  assert.ok(home.headers.get('content-type').includes('text/html'));
  assert.match(home.text, /<!doctype html>/);

  await req('POST', `${url}/pretty?name=viewer`);
  const page = await req('GET', `${url}/pretty`, { headers: { accept: 'text/html' } });
  assert.match(page.text, /viewer/);
  assert.match(page.text, /held/);

  // Unknown topics read as unused, not as errors.
  const virgin = await req('GET', `${url}/never-touched`);
  assert.equal(virgin.status, 200);
  assert.equal(virgin.json.capacity, null);
  assert.deepEqual(virgin.json.holders, []);
  assert.equal(virgin.json.waiting, 0);
});

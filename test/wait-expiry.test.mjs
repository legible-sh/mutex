// The time-dependent half of the API: long-poll blocking acquire with FIFO
// fairness, wait timeouts, TTL expiry, heartbeat renewal, and SSE events.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, req, sleep } from './helpers.mjs';

test('long-poll: waiters block and are granted strictly FIFO', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const holder = await req('POST', `${url}/queue?ttl=60&name=holder`);
  assert.equal(holder.status, 200);

  // Two waiters join, in order.
  const waiterA = req('POST', `${url}/queue?ttl=60&wait=10&name=alpha`);
  await sleep(80);
  const waiterB = req('POST', `${url}/queue?ttl=60&wait=10&name=beta`);
  await sleep(80);

  const s = await req('GET', `${url}/queue`);
  assert.equal(s.json.waiting, 2);

  // Release: alpha (first in line) gets it, beta keeps waiting.
  await req('DELETE', `${url}/queue/${holder.json.lease}`);
  const a = await waiterA;
  assert.equal(a.status, 200);
  assert.equal(a.json.name, 'alpha');
  assert.equal(a.json.fence, 2);

  await req('DELETE', `${url}/queue/${a.json.lease}`);
  const b = await waiterB;
  assert.equal(b.status, 200);
  assert.equal(b.json.name, 'beta');
  assert.equal(b.json.fence, 3);
});

test('long-poll: 408 with crowd info when the wait runs out', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  await req('POST', `${url}/stuck?ttl=60&name=hog`);
  const started = Date.now();
  const timedOut = await req('POST', `${url}/stuck?ttl=60&wait=0.3&name=patient`);
  assert.equal(timedOut.status, 408);
  assert.equal(timedOut.json.code, 'TIMEOUT');
  assert.ok(Date.now() - started >= 280, 'waited roughly the requested time');
  assert.deepEqual(timedOut.json.holders, ['hog']);
  assert.match(timedOut.json.hint, /rejoin the queue/, 'a 408 says how to keep waiting');
});

test('expiry: a dead holder frees the permit and unblocks a waiter', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const short = await req('POST', `${url}/flaky?ttl=0.25&name=doomed`);
  assert.equal(short.status, 200);

  // Blocking acquire outlives the holder's TTL.
  const next = await req('POST', `${url}/flaky?ttl=60&wait=5&name=heir`);
  assert.equal(next.status, 200);
  assert.equal(next.json.name, 'heir');
  assert.equal(next.json.fence, 2, 'the heir gets a strictly higher fence');

  // The dead lease is unusable: renew and release both 404.
  const renewDead = await req('POST', `${url}/flaky/${short.json.lease}/renew`);
  assert.equal(renewDead.status, 404);
  const releaseDead = await req('DELETE', `${url}/flaky/${short.json.lease}`);
  assert.equal(releaseDead.status, 404);
});

test('renew: heartbeats keep a lease alive past its original TTL', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const g = await req('POST', `${url}/beating?ttl=0.4&name=steady`);
  for (let i = 0; i < 3; i++) {
    await sleep(200);
    const r = await req('POST', `${url}/beating/${g.json.lease}/renew?ttl=0.4`);
    assert.equal(r.status, 200);
    assert.ok(new Date(r.json.expires).getTime() > Date.now());
  }
  // 600ms past the original expiry and still held.
  const s = await req('GET', `${url}/beating`);
  assert.equal(s.json.holders.length, 1);

  // Stop the heartbeat; the lease dies on its own.
  await sleep(500);
  const gone = await req('GET', `${url}/beating`);
  assert.equal(gone.json.holders.length, 0);
});

test('expired topic state survives correctly: reacquire keeps fence monotonic', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const first = await req('POST', `${url}/phoenix?ttl=0.15`);
  assert.equal(first.json.fence, 1);
  await sleep(250);
  const second = await req('POST', `${url}/phoenix?ttl=60`);
  assert.equal(second.status, 200);
  assert.equal(second.json.fence, 2, 'fences never reset, even after full expiry');
});

test('SSE: named events with JSON data for grant, release, expire', async (t) => {
  const { url, close } = await startServer({ heartbeatMs: 100 });
  t.after(close);

  const controller = new AbortController();
  const res = await fetch(`${url}/watched/sse`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readUntil = async (marker) => {
    while (!buffer.includes(marker)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended early');
      buffer += decoder.decode(value, { stream: true });
    }
  };

  await readUntil('event: status');
  assert.match(buffer, /"capacity":null/);

  const g = await req('POST', `${url}/watched?ttl=0.3&name=star`);
  await readUntil('event: grant');
  assert.match(buffer, /"name":"star"/);
  assert.match(buffer, /"fence":1/);
  assert.ok(!buffer.includes(g.json.lease), 'SSE must never leak lease tokens');

  await readUntil('event: expire');
  await readUntil(': hb');
  controller.abort();
});

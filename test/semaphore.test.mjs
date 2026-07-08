// Counting semaphores: capacity > 1, permit accounting, capacity agreement.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, req } from './helpers.mjs';

test('capacity=3: three permits, fourth bounces, release frees one', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const grants = [];
  for (const name of ['a', 'b', 'c']) {
    const g = await req('POST', `${url}/staging?ttl=60&capacity=3`, { headers: { 'x-name': name } });
    assert.equal(g.status, 200);
    assert.equal(g.json.capacity, 3);
    grants.push(g.json);
  }
  assert.deepEqual(grants.map((g) => g.fence), [1, 2, 3]);
  assert.deepEqual(grants[2].holders, ['a', 'b', 'c']);

  const fourth = await req('POST', `${url}/staging?ttl=60&capacity=3`, { headers: { 'x-name': 'd' } });
  assert.equal(fourth.status, 409);
  assert.equal(fourth.json.code, 'BUSY');
  assert.deepEqual(fourth.json.holders, ['a', 'b', 'c']);

  const s = await req('GET', `${url}/staging`);
  assert.equal(s.json.capacity, 3);
  assert.equal(s.json.holders.length, 3);

  // Free one permit; now a fourth agent fits.
  await req('DELETE', `${url}/staging/${grants[1].lease}`);
  const retry = await req('POST', `${url}/staging?ttl=60&capacity=3`, { headers: { 'x-name': 'd' } });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.fence, 4);
  assert.deepEqual(retry.json.holders, ['a', 'c', 'd']);
});

test('capacity must be agreed: explicit mismatch is 409 CONFLICT, omitting adopts', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  await req('POST', `${url}/pool?capacity=3&name=first`);

  const wrong = await req('POST', `${url}/pool?capacity=2&name=second`);
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json.code, 'CONFLICT');
  assert.equal(wrong.json.capacity, 3, 'conflict reply teaches the real capacity');
  assert.match(wrong.json.hint, /\?capacity=3/, 'and how to retry with it');

  const asMutex = await req('POST', `${url}/pool?capacity=1&name=third`);
  assert.equal(asMutex.status, 409);
  assert.equal(asMutex.json.code, 'CONFLICT');

  // No capacity param = "whatever it already is".
  const adopts = await req('POST', `${url}/pool?name=fourth`);
  assert.equal(adopts.status, 200);
  assert.equal(adopts.json.capacity, 3);

  // Capacity stays sticky even when the topic drains empty.
  const s1 = await req('GET', `${url}/pool`);
  for (const h of s1.json.holders) assert.equal(typeof h.fence, 'number');
  const conflictWhileEmpty = await req('POST', `${url}/empty-later?capacity=2`);
  await req('DELETE', `${url}/empty-later/${conflictWhileEmpty.json.lease}`);
  const still = await req('POST', `${url}/empty-later?capacity=5`);
  assert.equal(still.status, 409);
  assert.equal(still.json.code, 'CONFLICT');
});

test('each permit has its own lease; releasing one does not touch the others', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const g1 = await req('POST', `${url}/dual?capacity=2&name=one`);
  const g2 = await req('POST', `${url}/dual?capacity=2&name=two`);
  assert.notEqual(g1.json.lease, g2.json.lease);

  await req('DELETE', `${url}/dual/${g1.json.lease}`);
  const s = await req('GET', `${url}/dual`);
  assert.equal(s.json.holders.length, 1);
  assert.equal(s.json.holders[0].name, 'two');

  // g1's lease is dead; g2's still renews.
  const dead = await req('POST', `${url}/dual/${g1.json.lease}/renew`);
  assert.equal(dead.status, 404);
  const alive = await req('POST', `${url}/dual/${g2.json.lease}/renew?ttl=120`);
  assert.equal(alive.status, 200);
});

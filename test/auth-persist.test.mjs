// --token gating and --data-dir persistence (JSONL replay across restarts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, req, sleep } from './helpers.mjs';

test('token: POST/DELETE require the bearer, GET stays open', async (t) => {
  const { url, close } = await startServer({ token: 'hunter2' });
  t.after(close);

  const noAuth = await req('POST', `${url}/guarded`);
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.json.code, 'UNAUTHORIZED');

  const wrongAuth = await req('POST', `${url}/guarded`, { headers: { authorization: 'Bearer nope' } });
  assert.equal(wrongAuth.status, 401);

  const auth = { authorization: 'Bearer hunter2' };
  const g = await req('POST', `${url}/guarded?name=insider`, { headers: auth });
  assert.equal(g.status, 200);

  const renewNoAuth = await req('POST', `${url}/guarded/${g.json.lease}/renew`);
  assert.equal(renewNoAuth.status, 401);

  const releaseNoAuth = await req('DELETE', `${url}/guarded/${g.json.lease}`);
  assert.equal(releaseNoAuth.status, 401);

  // Status pages stay readable: they expose names and counts, never leases.
  const s = await req('GET', `${url}/guarded`);
  assert.equal(s.status, 200);
  assert.equal(s.json.holders[0].name, 'insider');

  const releaseAuth = await req('DELETE', `${url}/guarded/${g.json.lease}`, { headers: auth });
  assert.equal(releaseAuth.status, 200);
});

test('without --token everything is open (name-as-capability mode)', async (t) => {
  const { url, close } = await startServer();
  t.after(close);
  const g = await req('POST', `${url}/open`);
  assert.equal(g.status, 200);
  const r = await req('DELETE', `${url}/open/${g.json.lease}`);
  assert.equal(r.status, 200);
});

test('data-dir: leases, capacities, and fences survive a restart', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mutex-test-'));

  const first = await startServer({ dataDir });
  const live = await req('POST', `${first.url}/durable?ttl=120&capacity=2&name=survivor`);
  assert.equal(live.status, 200);
  const doomed = await req('POST', `${first.url}/ephemeral?ttl=0.15&name=ghost`);
  assert.equal(doomed.status, 200);
  await sleep(250); // let the ephemeral lease die before the "crash"
  await first.close();

  const second = await startServer({ dataDir });
  const closeSecond = second.close;
  try {
    // Live lease replayed: same holder, same fence, same capacity.
    const s = await req('GET', `${second.url}/durable`);
    assert.equal(s.json.capacity, 2);
    assert.equal(s.json.holders.length, 1);
    assert.equal(s.json.holders[0].name, 'survivor');
    assert.equal(s.json.holders[0].fence, 1);

    // The replayed lease token still works.
    const renewed = await req('POST', `${second.url}/durable/${live.json.lease}/renew?ttl=60`);
    assert.equal(renewed.status, 200);

    // The expired lease did not survive, but its fence did.
    const e = await req('GET', `${second.url}/ephemeral`);
    assert.equal(e.json.holders.length, 0);
    const reacquired = await req('POST', `${second.url}/ephemeral?ttl=60`);
    assert.equal(reacquired.json.fence, 2, 'fence is monotonic across restarts');

    // Capacity agreement is enforced across restarts too.
    const conflict = await req('POST', `${second.url}/durable?capacity=1`);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, 'CONFLICT');

    // The log was compacted on boot: topic snapshots + live grants only.
    const log = readFileSync(join(dataDir, 'mutex.jsonl'), 'utf8').trim().split('\n');
    const kinds = log.map((l) => JSON.parse(l).t);
    assert.ok(kinds.includes('topic'));
    assert.ok(!log.some((l) => l.includes(doomed.json.lease)), 'dead leases are compacted away');
  } finally {
    await closeSecond();
  }
});

test('in-memory mode writes nothing anywhere', async (t) => {
  const { server, url, close } = await startServer();
  t.after(close);
  await req('POST', `${url}/ram-only`);
  assert.equal(server.store.file, null);
});

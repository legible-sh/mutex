// The CLI end-to-end against a real server: every verb, plus the flock-style
// `mutex run` wrapper including the lease-lost kill path.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, req, sleep } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/mutex.mjs', import.meta.url));

function cli(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile('node', [BIN, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test('acquire / status / renew / release round-trip', async (t) => {
  const { url, close } = await startServer();
  t.after(close);
  const u = ['--url', url];

  const a = await cli(['acquire', 'cli-topic', '--ttl', '60', '--name', 'cli-worker', ...u]);
  assert.equal(a.code, 0);
  const grant = JSON.parse(a.stdout);
  assert.equal(grant.fence, 1);
  assert.equal(grant.name, 'cli-worker');

  const s = await cli(['status', 'cli-topic', ...u]);
  assert.equal(s.code, 0);
  const status = JSON.parse(s.stdout);
  assert.equal(status.holders[0].name, 'cli-worker');

  const r = await cli(['renew', 'cli-topic', grant.lease, '--ttl', '120', ...u]);
  assert.equal(r.code, 0);
  assert.ok(JSON.parse(r.stdout).expires);

  const d = await cli(['release', 'cli-topic', grant.lease, ...u]);
  assert.equal(d.code, 0);
  assert.equal(JSON.parse(d.stdout).released, true);

  const after = await req('GET', `${url}/cli-topic`);
  assert.equal(after.json.holders.length, 0);
});

test('acquire --wait 0 on a held topic exits 1 with the error on stderr', async (t) => {
  const { url, close } = await startServer();
  t.after(close);
  await req('POST', `${url}/contested?name=hog`);

  const a = await cli(['acquire', 'contested', '--wait', '0', '--url', url]);
  assert.equal(a.code, 1);
  assert.equal(a.stdout, '');
  const err = JSON.parse(a.stderr);
  assert.equal(err.code, 'BUSY');
  assert.deepEqual(err.holders, ['hog']);
});

test('MUTEX_URL env var works; unreachable server is a clean failure', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const viaEnv = await cli(['acquire', 'env-topic'], { env: { MUTEX_URL: url } });
  assert.equal(viaEnv.code, 0);
  assert.equal(JSON.parse(viaEnv.stdout).topic, 'env-topic');

  const dead = await cli(['status', 'x', '--url', 'http://127.0.0.1:1']);
  assert.equal(dead.code, 1);
  assert.match(dead.stderr, /cannot reach/);
});

test('token flag authenticates against a locked server', async (t) => {
  const { url, close } = await startServer({ token: 'sesame' });
  t.after(close);

  const denied = await cli(['acquire', 'vault', '--url', url]);
  assert.equal(denied.code, 1);

  const allowed = await cli(['acquire', 'vault', '--url', url, '--token', 'sesame']);
  assert.equal(allowed.code, 0);
});

test('run: acquires, exposes MUTEX_* env, releases on exit', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const r = await cli([
    'run', 'job', '--ttl', '30', '--url', url, '--',
    'node', '-e', 'console.log(`fence=${process.env.MUTEX_FENCE} topic=${process.env.MUTEX_TOPIC}`)',
  ]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /fence=1 topic=job/);
  assert.match(r.stderr, /acquired "job" fence=1/);

  const s = await req('GET', `${url}/job`);
  assert.equal(s.json.holders.length, 0, 'lock released after the command exits');
});

test('run: propagates the command exit code and still releases', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const r = await cli(['run', 'failjob', '--url', url, '--', 'node', '-e', 'process.exit(3)']);
  assert.equal(r.code, 3);
  const s = await req('GET', `${url}/failjob`);
  assert.equal(s.json.holders.length, 0);
});

test('run: kills the command and exits 75 when the lease is lost', async (t) => {
  const { server, url, close } = await startServer();
  t.after(close);

  const running = cli([
    'run', 'doomed-job', '--ttl', '0.5', '--url', url, '--',
    'node', '-e', 'setTimeout(() => console.log("should never print"), 8000)',
  ]);

  // Wait until the CLI holds the lock, then yank the lease from under it.
  let lease = null;
  for (let i = 0; i < 50 && !lease; i++) {
    await sleep(100);
    lease = server.manager.topics.get('doomed-job')?.holders.keys().next().value ?? null;
  }
  assert.ok(lease, 'run acquired the lock');
  server.manager.release('doomed-job', lease);

  const r = await running;
  assert.equal(r.code, 75);
  assert.match(r.stderr, /lease .* lost/);
  assert.ok(!r.stdout.includes('should never print'), 'command was killed');
});

test('help and unknown commands', async () => {
  const help = await cli(['help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /mutex acquire <topic>/);

  const unknown = await cli(['frobnicate']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command/);
});

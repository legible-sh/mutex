// Agent-discovery surfaces: /README.md, /llms.txt, and README content
// negotiation on GET / — all ungated, even with --token.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, req } from './helpers.mjs';

test('GET /README.md serves the README as text/markdown', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const r = await req('GET', `${url}/README.md`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/markdown; charset=utf-8/);
  assert.match(r.text, /mutex/);
  assert.match(r.text, /The whole API/, 'the file is served verbatim, not a summary');

  const head = await req('HEAD', `${url}/README.md`);
  assert.equal(head.status, 200);
  assert.equal(head.text, '', 'HEAD carries no body');
});

test('GET /llms.txt serves the pointer file', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const r = await req('GET', `${url}/llms.txt`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/plain; charset=utf-8/);
  assert.match(r.text, /^# mutex/, 'llms.txt convention: H1 title first');
  assert.match(r.text, /\/README\.md/, 'points agents at the full contract');
});

test('GET / negotiates: text/markdown gets the README, */* keeps the help text', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const md = await req('GET', url, { headers: { accept: 'text/markdown' } });
  assert.equal(md.status, 200);
  assert.match(md.headers.get('content-type'), /^text\/markdown; charset=utf-8/);
  assert.match(md.text, /The whole API/, 'markdown askers get the README');

  const plain = await req('GET', url, { headers: { accept: '*/*' } });
  assert.equal(plain.status, 200);
  assert.match(plain.headers.get('content-type'), /^text\/plain; charset=utf-8/);
  assert.match(plain.text, /acquire\s+POST/, 'plain curl keeps the help text');
  assert.doesNotMatch(plain.text, /The whole API/);
});

test('discovery routes stay open with --token', async (t) => {
  const { url, close } = await startServer({ token: 'hunter2' });
  t.after(close);

  const readme = await req('GET', `${url}/README.md`);
  assert.equal(readme.status, 200);

  const llms = await req('GET', `${url}/llms.txt`);
  assert.equal(llms.status, 200);
});

test('POST /README.md is 405 with a hint', async (t) => {
  const { url, close } = await startServer();
  t.after(close);

  const r = await req('POST', `${url}/README.md`);
  assert.equal(r.status, 405);
  assert.equal(r.json.code, 'METHOD_NOT_ALLOWED');
  assert.equal(r.headers.get('allow'), 'GET');
  assert.match(r.json.hint, /GET \/README\.md/);
});

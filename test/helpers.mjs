// Shared test plumbing: boot a real server on an ephemeral port, tiny fetch
// wrapper, sleep. Not a test file (npm test globs *.test.mjs only).

import { createServer } from '../src/server.mjs';

export async function startServer(options = {}) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
  return { server, url, close };
}

export async function req(method, url, { headers, body } = {}) {
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

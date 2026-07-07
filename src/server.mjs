// The HTTP server: a thin routing layer over src/semaphore.mjs.
//
//   POST   /{topic}?ttl&wait&capacity   acquire (X-Name / ?name / text body names you)
//   POST   /{topic}/{lease}/renew?ttl   heartbeat
//   DELETE /{topic}/{lease}             release
//   GET    /{topic}                     status (JSON; HTML for browsers; SSE via Accept)
//   GET    /{topic}/sse                 status events as SSE
//   GET    /                            help (text; HTML for browsers)

import { createServer as createHttpServer } from 'node:http';
import { createStore } from './store.mjs';
import { createManager, LockError } from './semaphore.mjs';
import { homePage, statusPage } from './pages.mjs';
import {
  TOPIC_PATTERN, DEFAULT_TTL_SECONDS, MIN_TTL_SECONDS, MAX_TTL_SECONDS,
  MAX_WAIT_SECONDS, MAX_CAPACITY, MAX_BODY_BYTES, MAX_NAME_LENGTH,
  SSE_HEARTBEAT_MS,
} from './limits.mjs';

const iso = (ms) => new Date(ms).toISOString();

const HELP = (base) => `mutex — flock(1) for agents that live on different machines

  acquire   POST   ${base}/{topic}?ttl=60            200 {lease,fence,expires} | 409 held
  block     POST   ${base}/{topic}?ttl=60&wait=300   long-poll, FIFO | 408 timeout
  semaphore POST   ${base}/{topic}?ttl=60&capacity=3 (acquirers must agree on capacity)
  renew     POST   ${base}/{topic}/{lease}/renew?ttl=60   404 = lease lost, stop working
  release   DELETE ${base}/{topic}/{lease}
  status    GET    ${base}/{topic}                   {capacity,holders,waiting}
  watch     GET    ${base}/{topic}/sse               SSE: status,grant,renew,release,expire

Name yourself with 'X-Name: worker-3' (or a plain-text body). Topics are
created on first use: [a-zA-Z0-9_-]{1,64} — pick something unguessable.
This is a lease, not a lock: pass the fence to the resource you protect
and reject writes from lower fences. https://github.com/legible-sh/mutex
`;

export function createServer(options = {}) {
  const {
    token = null,
    dataDir = null,
    baseUrl = null,
    heartbeatMs = SSE_HEARTBEAT_MS,
  } = options;

  const store = createStore({ dataDir });
  const manager = createManager({ store });

  const server = createHttpServer((req, res) => {
    route(req, res).catch((err) => {
      if (err instanceof LockError) return sendJson(res, err.status, err.body());
      console.error('mutex: unhandled error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error', code: 'INTERNAL' });
      else res.end();
    });
  });
  server.requestTimeout = 0; // long-polls may legitimately outlive the default
  server.manager = manager;
  server.store = store;
  server.on('close', () => manager.close());

  async function route(req, res) {
    const url = new URL(req.url, 'http://request-base'); // base only anchors parsing
    const base = baseUrl ?? `http://${req.headers.host ?? 'localhost'}`;
    const parts = url.pathname.split('/').filter(Boolean);

    res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, x-name',
      });
      return res.end();
    }

    if (parts.length === 0) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET');
      if (wants(req, 'text/html')) return sendHtml(res, homePage(base));
      return sendText(res, 200, HELP(base));
    }

    if (parts[0] === 'favicon.ico') { res.writeHead(204); return res.end(); }

    const topic = parts[0];
    if (!TOPIC_PATTERN.test(topic)) {
      throw new LockError(400, 'BAD_TOPIC', 'topics must match [a-zA-Z0-9_-]{1,64}');
    }

    // GETs are open even with --token: status pages show holder names and
    // counts, never lease tokens, so reading them grants no capability.
    if (token && req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers.authorization !== `Bearer ${token}`) {
        throw new LockError(401, 'UNAUTHORIZED', 'missing or wrong bearer token');
      }
    }

    if (parts.length === 1) {
      if (req.method === 'POST') return acquire(req, res, url, topic);
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (req.method === 'GET' && wants(req, 'text/event-stream')) return sse(req, res, topic);
        if (wants(req, 'text/html')) return sendHtml(res, statusPage(base, manager.status(topic)));
        return sendJson(res, 200, statusView(topic));
      }
      if (req.method === 'DELETE') {
        return methodNotAllowed(res, 'GET, POST', 'release is DELETE /{topic}/{lease}');
      }
      return methodNotAllowed(res, 'GET, POST');
    }

    if (parts.length === 2) {
      if (parts[1] === 'sse' && req.method === 'GET') {
        return sse(req, res, topic);
      }
      if (req.method === 'DELETE') {
        const out = manager.release(topic, parts[1]);
        return sendJson(res, 200, out);
      }
      return methodNotAllowed(res, 'DELETE');
    }

    if (parts.length === 3 && parts[2] === 'renew') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
      const ttlMs = parseTtl(url);
      const out = manager.renew(topic, parts[1], ttlMs);
      return sendJson(res, 200, { ...out, expires: iso(out.expires) });
    }

    throw new LockError(404, 'NOT_FOUND', 'no such route');
  }

  async function acquire(req, res, url, topic) {
    const ttlMs = parseTtl(url);
    const waitMs = parseWait(url);
    const capacity = parseCapacity(url);
    const name = await resolveName(req, url);

    const { promise, cancel } = manager.acquire({ topic, name, ttlMs, waitMs, capacity });
    if (waitMs > 0) req.on('close', cancel); // client hung up; leave the queue
    const grant = await promise;
    const base = baseUrl ?? `http://${req.headers.host ?? 'localhost'}`;
    sendJson(res, 200, {
      ...grant,
      ttl: ttlMs / 1000,
      expires: iso(grant.expires),
      renew: `${base}/${topic}/${grant.lease}/renew?ttl=${ttlMs / 1000}`,
      release: `${base}/${topic}/${grant.lease}`,
    });
  }

  function statusView(topic) {
    const s = manager.status(topic);
    return {
      ...s,
      holders: s.holders.map((h) => ({ ...h, since: iso(h.since), expires: iso(h.expires) })),
    };
  }

  function sse(req, res, topic) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`event: status\ndata: ${JSON.stringify(statusView(topic))}\n\n`);

    const onEvent = (e) => {
      if (e.topic !== topic) return;
      res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
    };
    manager.on('event', onEvent);
    const beat = setInterval(() => res.write(': hb\n\n'), heartbeatMs);
    req.on('close', () => {
      clearInterval(beat);
      manager.off('event', onEvent);
    });
  }

  async function resolveName(req, url) {
    let name = req.headers['x-name'] ?? url.searchParams.get('name');
    if (name == null) name = (await readBody(req)).trim();
    name = String(name).trim();
    if (name.length > MAX_NAME_LENGTH) {
      throw new LockError(400, 'BAD_PARAM', `name longer than ${MAX_NAME_LENGTH} chars`);
    }
    return name || null;
  }

  return server;
}

// ---- parsing & responses ----------------------------------------------------

function parseTtl(url) {
  const raw = url.searchParams.get('ttl');
  if (raw === null || raw === '') return DEFAULT_TTL_SECONDS * 1000;
  const ttl = Number(raw);
  if (!Number.isFinite(ttl) || ttl < MIN_TTL_SECONDS || ttl > MAX_TTL_SECONDS) {
    throw new LockError(400, 'BAD_PARAM',
      `ttl must be ${MIN_TTL_SECONDS}-${MAX_TTL_SECONDS} seconds`);
  }
  return ttl * 1000;
}

function parseWait(url) {
  const raw = url.searchParams.get('wait');
  if (raw === null || raw === '') return 0;
  const wait = Number(raw);
  if (!Number.isFinite(wait) || wait < 0 || wait > MAX_WAIT_SECONDS) {
    throw new LockError(400, 'BAD_PARAM', `wait must be 0-${MAX_WAIT_SECONDS} seconds`);
  }
  return wait * 1000;
}

function parseCapacity(url) {
  const raw = url.searchParams.get('capacity');
  if (raw === null || raw === '') return null;
  const capacity = Number(raw);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    throw new LockError(400, 'BAD_PARAM', `capacity must be an integer 1-${MAX_CAPACITY}`);
  }
  return capacity;
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new LockError(413, 'TOO_LARGE', `body larger than ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function wants(req, type) {
  return (req.headers.accept ?? '').includes(type);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2) + '\n';
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function methodNotAllowed(res, allow, hint = null) {
  res.setHeader('allow', allow);
  sendJson(res, 405, { error: hint ?? `use ${allow}`, code: 'METHOD_NOT_ALLOWED' });
}

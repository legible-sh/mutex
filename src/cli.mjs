// The CLI: a thin client over the same HTTP API, plus `mutex serve`.
// Base URL: --url flag > MUTEX_URL env > https://mutex.legible.sh
// Token:    --token flag > MUTEX_TOKEN env

import { spawn } from 'node:child_process';
import { createServer } from './server.mjs';
import { DEFAULT_PORT, DEFAULT_TTL_SECONDS } from './limits.mjs';

const USAGE = `mutex — flock(1) for agents that live on different machines

usage:
  mutex acquire <topic> [--ttl 60] [--wait 300] [--capacity 1] [--name me]
  mutex renew   <topic> <lease> [--ttl 60]
  mutex release <topic> <lease>
  mutex status  <topic>
  mutex run     <topic> [acquire flags] -- <command...>
  mutex serve   [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--data-dir DIR] [--token T] [--base-url URL]

client flags:
  --url URL      server (default: $MUTEX_URL or https://mutex.legible.sh)
  --token T      bearer token (default: $MUTEX_TOKEN)

acquire blocks up to --wait seconds like flock(1); pass --wait 0 to fail fast.
run acquires, heartbeats at ttl/3, runs the command with MUTEX_TOPIC /
MUTEX_LEASE / MUTEX_FENCE in its env, releases on exit — and kills the
command if a renew is refused (the lease is gone; someone else may hold it).

exit codes: 0 ok · 1 busy, timeout, or error · 75 lease lost during run
`;

class ApiError extends Error {
  constructor(status, body) {
    super(typeof body === 'object' && body?.error ? body.error : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function main(argv) {
  const [command, ...rest] = argv;
  const { flags, positional, passthrough } = parseArgs(rest);
  const ctx = {
    url: (flags.url ?? process.env.MUTEX_URL ?? 'https://mutex.legible.sh').replace(/\/+$/, ''),
    token: flags.token ?? process.env.MUTEX_TOKEN ?? null,
  };

  try {
    switch (command) {
      case 'acquire': return await cmdAcquire(ctx, positional, flags);
      case 'renew': return await cmdRenew(ctx, positional, flags);
      case 'release': return await cmdRelease(ctx, positional);
      case 'status': return await cmdStatus(ctx, positional);
      case 'run': return await cmdRun(ctx, positional, flags, passthrough);
      case 'serve': return cmdServe(flags);
      case 'help': case '--help': case '-h': case undefined:
        process.stdout.write(USAGE);
        process.exitCode = command ? 0 : 2;
        return;
      default:
        process.stderr.write(`mutex: unknown command "${command}"\n\n${USAGE}`);
        process.exitCode = 2;
    }
  } catch (err) {
    if (err instanceof ApiError) {
      process.stderr.write(JSON.stringify(err.body, null, 2) + '\n');
    } else {
      process.stderr.write(`mutex: ${err.message}\n`);
    }
    process.exitCode = 1;
  }
}

// ---- commands ---------------------------------------------------------------

async function cmdAcquire(ctx, [topic], flags) {
  requireTopic(topic);
  const grant = await acquire(ctx, topic, flags);
  print(grant);
}

async function cmdRenew(ctx, [topic, lease], flags) {
  requireTopic(topic);
  requireLease(lease);
  const query = flags.ttl != null ? { ttl: flags.ttl } : {};
  print(await api(ctx, 'POST', `/${topic}/${lease}/renew`, query));
}

async function cmdRelease(ctx, [topic, lease]) {
  requireTopic(topic);
  requireLease(lease);
  print(await api(ctx, 'DELETE', `/${topic}/${lease}`));
}

async function cmdStatus(ctx, [topic]) {
  requireTopic(topic);
  print(await api(ctx, 'GET', `/${topic}`));
}

async function cmdRun(ctx, [topic], flags, passthrough) {
  requireTopic(topic);
  if (!passthrough || passthrough.length === 0) {
    throw new Error('run needs a command after "--", e.g. mutex run deploy -- ./deploy.sh');
  }
  const grant = await acquire(ctx, topic, flags);
  const ttlSeconds = Number(flags.ttl ?? DEFAULT_TTL_SECONDS);
  process.stderr.write(`mutex: acquired "${topic}" fence=${grant.fence} as ${grant.name}\n`);

  let lost = false;
  const child = spawn(passthrough[0], passthrough.slice(1), {
    stdio: 'inherit',
    env: {
      ...process.env,
      MUTEX_TOPIC: topic,
      MUTEX_LEASE: grant.lease,
      MUTEX_FENCE: String(grant.fence),
    },
  });

  const beat = setInterval(async () => {
    try {
      await api(ctx, 'POST', `/${topic}/${grant.lease}/renew`, { ttl: ttlSeconds });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        lost = true;
        clearInterval(beat);
        process.stderr.write(`mutex: lease on "${topic}" lost — killing command\n`);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      }
      // Anything else (network blip, 5xx) is retried at the next beat.
    }
  }, Math.max(100, (ttlSeconds * 1000) / 3));

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig));
  }

  const code = await new Promise((resolve) => {
    child.on('exit', (c, s) => resolve(s ? 1 : (c ?? 1)));
    child.on('error', (err) => {
      process.stderr.write(`mutex: failed to run command: ${err.message}\n`);
      resolve(127);
    });
  });
  clearInterval(beat);
  if (!lost) {
    try { await api(ctx, 'DELETE', `/${topic}/${grant.lease}`); } catch { /* already gone */ }
  }
  process.exitCode = lost ? 75 : code;
}

function cmdServe(flags) {
  const port = Number(flags.port ?? process.env.PORT ?? DEFAULT_PORT);
  const host = flags.host ?? '127.0.0.1';
  const server = createServer({
    dataDir: flags['data-dir'] ?? null,
    token: flags.token ?? null,
    baseUrl: flags['base-url']?.replace(/\/+$/, '') ?? null,
  });
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
    console.log(`mutex listening on http://${shown}:${port}`
      + (flags['data-dir'] ? ` (data: ${flags['data-dir']})` : ' (in-memory)')
      + (flags.token ? ' (token required for POST/DELETE)' : ''));
  });
  return server;
}

// ---- HTTP client ------------------------------------------------------------

async function acquire(ctx, topic, flags) {
  const query = { wait: flags.wait ?? 300 };
  if (flags.ttl != null) query.ttl = flags.ttl;
  if (flags.capacity != null) query.capacity = flags.capacity;
  if (flags.name != null) query.name = flags.name;
  return api(ctx, 'POST', `/${topic}`, query);
}

async function api(ctx, method, path, query = {}) {
  const url = new URL(ctx.url + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers = {};
  if (ctx.token) headers.authorization = `Bearer ${ctx.token}`;
  let res;
  try {
    res = await fetch(url, { method, headers });
  } catch (err) {
    throw new Error(`cannot reach ${url.origin} (${err.cause?.code ?? err.message})`);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

// ---- helpers ------------------------------------------------------------------

function parseArgs(args) {
  const flags = {};
  const positional = [];
  let passthrough = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      passthrough = args.slice(i + 1);
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional, passthrough };
}

function requireTopic(topic) {
  if (!topic) throw new Error('missing <topic> (see: mutex help)');
}

function requireLease(lease) {
  if (!lease) throw new Error('missing <lease> (see: mutex help)');
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

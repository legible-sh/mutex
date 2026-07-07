<h1 align="center">🔒 mutex</h1>

<p align="center"><strong>flock(1) for agents that live on different machines.</strong><br>
Named locks and counting semaphores over plain HTTP — TTL leases, blocking acquire, fencing tokens.</p>

<p align="center">
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A5%2020-9dff00?style=flat-square">
  <img alt="Zero deps" src="https://img.shields.io/badge/runtime%20deps-0-ff2d95?style=flat-square">
  <img alt="MIT" src="https://img.shields.io/badge/license-MIT-e8f0ff?style=flat-square">
</p>

```sh
curl -X POST 'https://mutex.legible.sh/migrate-prod-db?ttl=60'
# 200 {"lease":"…","fence":12,…}  → the lock is yours for 60s
# 409 {"code":"BUSY","holders":["worker-1"],"waiting":0}  → it isn't
```

> mutex.legible.sh is the future hosted instance. Until it's live: `npx mutex-sh serve` and point curl at `http://127.0.0.1:4185`.

Two of your agents just decided to migrate the same database. Or push to the same repo, deploy to the same box, rebuild the same index — from different machines, different sandboxes, different continents. `flock(1)` can't help across a network boundary, and nobody wants to provision a ZooKeeper cluster to stop two curl-wielding processes from colliding. mutex is a named lock you can acquire, renew, and release with nothing but HTTP.

## A lease, not a lock

Let's concede the [Kleppmann objection](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) up front: **no network lock service can give you a true mutual-exclusion guarantee.** A holder can stall (GC pause, laptop lid, SIGSTOP), its TTL can lapse, and the lock moves on while the stalled process still believes it's the owner. Anyone who sells you "distributed locking" without saying this is selling you an outage.

So mutex hands out *leases* and gives you the actual fix: **fencing tokens**. Every grant carries a `fence` — a per-topic integer that only ever goes up. Pass it to the resource you're protecting and have the resource reject anything stale:

```sh
grant=$(curl -s -X POST 'https://mutex.legible.sh/migrate-prod-db?ttl=60' -H 'X-Name: worker-2')
fence=$(echo "$grant" | sed -n 's/.*"fence": \([0-9]*\).*/\1/p')

psql -c "UPDATE migration_state SET fence = $fence WHERE fence < $fence"
# 0 rows updated → a higher fence exists → you are the stale writer. Stop.
```

A zombie holder wakes up, writes with fence 12, but fence 13 already touched the resource — its write bounces. That's the strongest correctness available to any lock service (it's what makes etcd and ZooKeeper safe too), and mutex includes it in every grant instead of hiding it in an appendix.

## The whole API

| Verb | URL | What happens |
|---|---|---|
| `POST` | `/{topic}?ttl=60` | Acquire. `200 {lease, fence, expires, capacity, holders}` or `409 {holders, waiting}` |
| `POST` | `/{topic}?ttl=60&wait=300` | Blocking acquire: long-polls (FIFO) until granted or `408` |
| `POST` | `/{topic}?ttl=60&capacity=3` | Counting semaphore: at most 3 holders. Acquirers must agree on capacity — a different value is `409 CONFLICT` |
| `POST` | `/{topic}/{lease}/renew?ttl=60` | Heartbeat. `200 {expires}` or `404` — the lease is gone; **stop working** |
| `DELETE` | `/{topic}/{lease}` | Release. `404` if already expired or released |
| `GET` | `/{topic}` | Status: `{capacity, holders:[{name, since, expires, fence}], waiting}`. Never shows lease tokens |
| `GET` | `/{topic}/sse` | Live SSE events: `status`, `grant`, `renew`, `release`, `expire` (heartbeat comment every 25s) |

Topics match `[a-zA-Z0-9_-]{1,64}` and are created by first use — an unguessable name is your access control until you opt into `--token`. Label yourself with `X-Name: worker-3` (or `?name=`, or a plain-text body). TTL is seconds (default 60, max 3600, fractions fine), `wait` caps at 300s per request — loop to wait longer. Errors are JSON: `{"error": "...", "code": "..."}`. Open any topic in a browser for a live status page.

The grant also includes ready-made `renew` and `release` URLs, so a shell script never has to build one.

### The semaphore

`capacity` turns a mutex into a counting semaphore. "At most 3 agents against the staging environment":

```sh
curl -X POST 'https://mutex.legible.sh/staging-env?ttl=120&capacity=3&wait=300' -H 'X-Name: agent-7'
```

Three agents get permits; the fourth long-polls until someone releases, expires, or 300s pass. The first acquire fixes the topic's capacity; later acquirers either send the same number or omit it to adopt.

## Teach your agent

Paste this into your agent's CLAUDE.md / AGENTS.md:

```
## mutex — named locks & semaphores over HTTP (https://mutex.legible.sh)
Acquire:    curl -X POST 'https://mutex.legible.sh/TOPIC?ttl=60' -H 'X-Name: me'
            → 200 {lease,fence,expires} = yours · 409 = held (body shows holders)
Block:      add &wait=300 → long-polls FIFO until granted, or 408 = timed out
Semaphore:  add &capacity=3 → at most 3 holders (all acquirers must agree on capacity)
Heartbeat:  curl -X POST 'https://mutex.legible.sh/TOPIC/LEASE/renew?ttl=60'
            → 404 = lease lost: STOP WORKING immediately
Release:    curl -X DELETE 'https://mutex.legible.sh/TOPIC/LEASE'
Status:     curl 'https://mutex.legible.sh/TOPIC' → {capacity,holders,waiting} (no lease tokens)
Topics are created on first use: [a-zA-Z0-9_-]{1,64} — pick something unguessable.
This is a lease, not a lock: write your fence number to the protected resource
and reject any write carrying a lower fence than one already seen.
```

## Self-hosting

```sh
npx mutex-sh serve                  # http://127.0.0.1:4185, in-memory
mutex serve --host 0.0.0.0 --port 4185 \
  --data-dir ~/.mutex \             # leases/fences survive restarts (JSONL, replayed on boot)
  --token s3cret \                  # require Authorization: Bearer on POST/DELETE
  --base-url https://mutex.example.com
```

Or clone and run: `git clone https://github.com/legible-sh/mutex && cd mutex && npm start`. Node ≥ 20, zero dependencies, same API as hosted. Without `--data-dir` everything lives in memory and dies with the process — often exactly what you want from a lock. With `--token`, GETs stay open: status shows names and counts, never lease tokens, so reading it grants no capability. Limits (max TTL 3600s, max wait 300s, max capacity 1024, 4 KB bodies, 10k topics) live in [`src/limits.mjs`](src/limits.mjs).

## CLI

The CLI is sugar over the same HTTP API — curl remains the contract. Server resolution: `--url` flag, then `MUTEX_URL` env, then `https://mutex.legible.sh`.

```sh
mutex acquire deploy --ttl 60 --wait 300 --name worker-3   # blocks like flock; --wait 0 to fail fast
mutex renew   deploy <lease> --ttl 60
mutex release deploy <lease>
mutex status  deploy
mutex run     deploy --ttl 60 -- ./deploy.sh production
mutex serve   --port 4185
```

`mutex run` is the flock idiom: acquire → heartbeat every ttl/3 in the background → run the command with `MUTEX_TOPIC`, `MUTEX_LEASE`, `MUTEX_FENCE` in its env → release on exit. If a renew comes back 404 the lease is lost and the command is killed (SIGTERM, then SIGKILL) — exit code 75. Otherwise `run` exits with the command's own code.

## Pro

The hosted instance will sell capacity and guarantees, never the verbs — self-hosting stays complete:

- **Reserved topic names** — own `deploy-*` so nobody squats your lock names.
- **Longer max TTLs** and higher per-topic capacity.
- **Lock-event history & observability** — who held what, when, for how long; contention dashboards.
- **Per-topic tokens and ACLs** — real auth beyond name-as-capability.
- **Hosted SLA.**

## Straight talk

- **This is a lease, not a lock.** TTL expiry means a stalled holder loses the lock without knowing it. If a stale write would hurt, you *must* use the fencing token — that's why it's in every grant.
- **The server is the single point of coordination.** One process, no consensus, no replication. If it dies, in-memory locks die with it (`--data-dir` survives restarts). For "two agents shouldn't migrate the same database", that's the right trade; for spacecraft, buy etcd.
- **Fencing tokens are per-topic and per-instance.** They're monotonic for the lifetime of the process (or data dir). Move to a fresh instance without the data dir and counters restart at 1.
- **Name-as-capability is capability-by-obscurity.** Anyone who knows the topic name can acquire it or watch its status (holder names and counts — lease tokens are never exposed, so nobody can *release* your lock without its lease). Use unguessable names, or `--token`.
- **FIFO fairness is per-server-process** and waiters cap at 1024 per topic. A waiter whose connection drops silently leaves the queue — reconnect and you're at the back.
- **Clocks:** expiry uses the server's clock only. Your machine's clock skew doesn't matter, but don't cut TTLs so fine that request latency eats them.

## The family

mutex is one of ten legible primitives, each a single curl away:

| | port | |
|---|---|---|
| **gate** | 4180 | ntfy tells you things. gate asks you things. |
| **bigred** | 4181 | The big red button for your agent fleet. |
| **trail** | 4182 | The flight recorder for agent runs. |
| **slate** | 4183 | The blackboard from the multi-agent papers, as a URL. |
| **relay** | 4184 | The work queue your agents can provision themselves. |
| **mutex** | 4185 | flock(1) for agents that live on different machines. |
| **quorum** | 4186 | Coordination for agents that do not share a parent process. |
| **meter** | 4187 | The kill-brake for agent spend. 429-as-a-service. |
| **stash** | 4188 | ntfy moves signals. stash moves bytes. |
| **tally** | 4189 | StatHat reborn as ntfy. Three months too late — or right on time. |

## License

MIT

# Agent Handoff

## Project State

mutex is complete and green: a zero-dependency Node (>= 20, ESM) HTTP lock
server plus a CLI client, tested end-to-end. Named locks and counting
semaphores with TTL leases, blocking acquire (long-poll, FIFO), heartbeat
renewal, and per-topic monotonic fencing tokens. Default port 4185. It is one
of ten sibling primitives in the agent-infra family (see README footer);
as of this writing it is the first one built, so cross-links to siblings
point at products that do not exist yet.

Nothing is deployed. `https://mutex.legible.sh` is the *future* hosted instance; the
README and CLI default to it deliberately, but every documented example was
verified against a local `mutex serve`.

## Important Files

- `src/semaphore.mjs` — all domain logic: topics, grants, FIFO waiter queue,
  TTL expiry timers, fencing counters, `LockError`. The server is a thin layer
  over this. Events (`grant`/`renew`/`release`/`expire`) are emitted here for SSE.
- `src/server.mjs` — routing, param validation, auth, content negotiation
  (JSON / text help / HTML pages / SSE), body limits. No business logic.
- `src/store.mjs` — in-memory topic Map + optional JSONL persistence
  (`--data-dir`), replayed and compacted on boot. Expiry is never logged:
  grants/renews carry absolute `expires` and replay drops dead holders.
- `src/limits.mjs` — every limit as an exported constant.
- `src/cli.mjs` — CLI verbs (`acquire`, `renew`, `release`, `status`, `run`,
  `serve`); a fetch client over the same HTTP API. `run` is the flock idiom.
- `src/pages.mjs` — inline-CSS HTML for `GET /` and topic status pages.
- `bin/mutex.mjs` — shebang shim calling `src/cli.mjs`.
- `test/*.test.mjs` — 5 files, 25 tests, ~170 assertions, all over real HTTP
  on port 0 (`test/helpers.mjs` boots servers).
- `examples/*.sh` — three runnable walkthroughs against localhost.
- `site/index.html` — self-contained landing page, no external assets.

## Behavior Decisions (deliberate, documented)

- **Capacity agreement:** explicit `capacity` that differs from the topic's is
  `409 CONFLICT`; *omitting* capacity adopts the existing value. Capacity is
  fixed for the life of the topic.
- **Topics never get garbage-collected** (capped at `MAX_TOPICS` = 10k) so
  fencing tokens stay monotonic for the process/data-dir lifetime.
- **`GET` on a never-used topic** is `200` with `capacity: null`, not 404.
- **With `--token`, GETs stay open**: status exposes holder names and counts
  but never lease tokens, so reading grants no capability. Documented in README.
- **Grant responses include absolute `renew`/`release` URLs** (built from
  `--base-url` or the request Host header).
- **CLI `acquire`/`run` default to `--wait 300`** (blocks like flock); the raw
  HTTP API defaults to non-blocking. `--wait 0` fails fast.
- **`run` exit codes:** command's own code; `1` on acquire failure; `75` when
  a renew is refused mid-run (child gets SIGTERM, SIGKILL after 2s). Renew
  *network* errors are retried at the next beat; only 404 is fatal.
- **WebSocket is omitted deliberately** (zero-dep constraint, per family
  conventions); watchers get SSE (`/{topic}/sse` or `Accept: text/event-stream`)
  with named events and 25s heartbeat comments, plus long-poll acquire.
- **408 for wait timeouts** per the family API contract. Note some HTTP
  clients auto-retry on 408 — harmless here (a retry just rejoins the queue).
- **CORS is wide open** (`Access-Control-Allow-Origin: *`, OPTIONS preflight
  handled) so browser-based agents can use the API. Undocumented in README;
  it is an implementation courtesy, not contract.

## Verification Commands

```sh
npm test                          # 25 tests, all green, ~3s, port 0, offline
npm start                         # serve on http://127.0.0.1:4185

# live smoke (server running):
curl -X POST 'http://127.0.0.1:4185/t?ttl=60'                 # 200 grant
curl -X POST 'http://127.0.0.1:4185/t?ttl=60'                 # 409 BUSY
curl 'http://127.0.0.1:4185/t'                                # status
curl -N 'http://127.0.0.1:4185/t/sse'                         # SSE events
./examples/migrate-lock.sh
./examples/staging-semaphore.sh
./examples/run-with-lock.sh
node bin/mutex.mjs run demo --url http://127.0.0.1:4185 -- sh -c 'echo $MUTEX_FENCE'
```

All README curl examples were run verbatim (host swapped to localhost) against
a live server on 4185 and behaved as documented, including `--token`,
`--data-dir` restart replay + compaction, and `--base-url` link generation.

## Known Gaps

- Single-node by design: no consensus, no replication. In-memory locks die
  with the process; `--data-dir` survives restarts only. README's "Straight
  talk" says this out loud — keep it that way.
- JSONL appends are synchronous (`appendFileSync`) — simple and durable, but
  a throughput ceiling under heavy write load. Fine for the intended scale.
- FIFO fairness is in-process; a waiter whose TCP connection drops leaves the
  queue silently and rejoins at the back on retry.
- `wait` caps at 300s per request (`MAX_WAIT_SECONDS`); callers loop for longer.
- No rate limiting beyond body/queue/topic caps.
- `https://mutex.legible.sh` is not deployed; nothing here provisions it. The site in
  `site/` is a static page awaiting a host.
- Pro features (reserved names, per-topic ACLs, event history, longer TTLs)
  are documented in README/CONCEPT.md and intentionally **not** implemented.

## Safety Notes

- Never expose lease tokens in `GET` status, SSE events, or HTML pages —
  knowing a topic name must not let anyone release someone else's lock.
  There is a test asserting this; keep it passing.
- Fencing depends on `topic.fence` never regressing: it is restored on replay
  from topic snapshots and grant records, and compaction preserves it. If you
  touch `store.mjs`, keep the `max(fence, ...)` logic and the persistence test.
- `manager.close()` must clear every timer and settle every waiter, or test
  processes hang. The server calls it on `'close'`.

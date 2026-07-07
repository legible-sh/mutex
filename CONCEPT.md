# CONCEPT — why mutex exists

## The need

Agent fleets have rediscovered every classic concurrency bug, but across machines. Two Claude Code sessions migrate the same database. Parallel subagents fight over one git index ([claude-code#34645](https://github.com/anthropics/claude-code/issues/34645) — lock contention between parallel subagents is a top complaint). CI jobs from different repos deploy to the same box. The operators hitting this are not going to provision a ZooKeeper ensemble; they reach for whatever mutual exclusion is one line away:

- **Google Sheets tab names as a distributed mutex** — the fast.io fleet guide documents teams literally renaming spreadsheet tabs as a lock protocol, because a shared spreadsheet was the only coordination point every machine could reach.
- **A cottage industry of GitHub Actions mutex hacks** — marketplace actions, `concurrency:` group abuse, branch-as-lockfile tricks — each scoped to one CI system and useless to an agent on a laptop.
- **`flock` on a shared file** — works until the second machine shows up.

The primitive is ancient and the demand is provably there. What's missing is a lock whose entire integration cost is one curl, usable from inside a sandboxed agent that has nothing but HTTP egress.

## Competitors, and why they fall short

| | What it is | Why it doesn't serve this user |
|---|---|---|
| **dlock** | curl-first locks with fencing on Cloudflare Durable Objects | The right instinct — and dead. Zero commits since June 2022. No blocking acquire, no semaphores, no self-host. |
| **Lockable** | Show HN 2022, same one-curl pitch | Dead. Hosted-only, no fencing, and the HN thread predictably linked Kleppmann within minutes. |
| **Dapr lock API** | Lock building block in the Dapr runtime | Requires running a sidecar plus a state store on every node. That's a platform commitment, not a curl. Alpha for years; non-blocking try-lock only. |
| **etcd / Consul / ZooKeeper** | The real thing: consensus-backed sessions and locks | Correct, and correctly heavyweight: cluster provisioning, client libraries, multi-step session/lease dances. Nobody spins up a Raft quorum because two cron-driven agents share a staging server. |
| **Redis SETNX / Redlock** | The folk remedy | You run and secure the Redis, you implement renewal, fencing, and blocking yourself, and Redlock's guarantees are famously contested. |

The two direct predecessors — the products with exactly this pitch — both died. The lane is empty, which is either an opportunity or a warning. We think it's both (see risks).

## The angle

Not "a distributed lock service." That product has died twice, and its HN thread writes itself. mutex is **the traffic-control layer for agent fleets**, one primitive in a ten-tool suite, and it differentiates on the things the predecessors never shipped:

1. **Blocking acquire.** `?wait=300` long-polls with FIFO fairness — `flock`'s actual behavior, which no curl-first predecessor offered. Try-lock-and-poll is where most homemade lock bugs live; blocking removes the loop.
2. **Counting semaphores, first-class.** `capacity=3` for "at most 3 agents against staging" is the same URL and the same verbs. Every competitor treats this as a different product; for fleet throttling it's the *common* case.
3. **Fencing by default.** Every grant carries a monotonic fence. The guaranteed Kleppmann objection becomes the differentiator: the docs open by conceding "this is a lease, not a lock" and teach the fence-check pattern before anything else. Honesty is the moat, because in this category the pedants are right and they review loudly.
4. **The family idioms.** Same topics, same long-poll, same SSE, same `--token`, same one-screen API as the nine siblings. An agent that learned one has learned them all.

## Honest risks

- **Standalone lock products die of thinness.** A lock service is a feature, not a company — dlock and Lockable both proved it. Mitigation: mutex is not standalone. It's positioned inside the legible suite, shares its hosted footprint, and is discovered through the family. Ten thin primitives make one thick offering.
- **Correctness pedantry is a permanent audience.** Any lock-over-HTTP launch attracts the Kleppmann link within minutes. Mitigation: agree with the objection in the first paragraph, ship fencing in every grant, and never use the word "guarantee." Reviewers can only repeat what the README already says.
- **Single-node coordination is a real limit.** No consensus, no failover; the hosted instance is a SPOF for its locks. Mitigation: say so plainly ("for spacecraft, buy etcd"), keep `--data-dir` restart survival, and note that the target workload — human-scale agent fleets — tolerates seconds of lock-service downtime.
- **The hosted instance can read your topic names.** Capability-by-obscurity is honest but weak. Mitigation: unguessable names by convention, `--token` for self-hosters, per-topic ACLs on the paid tier.

## Premium path

Free tier (and self-host, forever): every verb, every feature above. The hosted Pro tier sells capacity and assurance, never the verbs:

- **Reserved topic names** (own a prefix; no squatting)
- **Longer max TTLs** and higher capacities/queue depths
- **Lock-event history and observability** — who held what, when; contention dashboards; wait-time percentiles
- **Per-topic tokens / ACLs**
- **SLA** on the hosted instance

Each of these is worthless to a hobbyist and obviously worth $20/mo to a team whose deploy pipeline serializes through `mutex.legible.sh/deploy-prod`.

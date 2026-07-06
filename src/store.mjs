// State: an in-memory Map of topics, optionally backed by a JSONL log.
//
// Record types in <data-dir>/mutex.jsonl:
//   {"t":"topic","topic":..,"capacity":..,"fence":..}   topic created / compaction snapshot
//   {"t":"grant","topic":..,"lease":..,"name":..,"fence":..,"since":..,"expires":..}
//   {"t":"renew","topic":..,"lease":..,"expires":..}
//   {"t":"release","topic":..,"lease":..}
//
// Expiry is not logged: every grant/renew carries an absolute `expires`
// (epoch ms), so replay simply drops holders that are already dead.
// The log is compacted on boot (topic snapshots + live grants only).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function blankTopic(name, capacity) {
  return { name, capacity, fence: 0, holders: new Map(), waiters: [], timer: null };
}

export function createStore({ dataDir = null, now = Date.now } = {}) {
  const topics = new Map();
  let file = null;

  if (dataDir) {
    mkdirSync(dataDir, { recursive: true });
    file = join(dataDir, 'mutex.jsonl');
    if (existsSync(file)) replay(file, topics, now());
    compact();
  }

  function append(record) {
    if (!file) return;
    appendFileSync(file, JSON.stringify(record) + '\n');
  }

  function compact() {
    if (!file) return;
    const lines = [];
    for (const [name, t] of topics) {
      lines.push(JSON.stringify({ t: 'topic', topic: name, capacity: t.capacity, fence: t.fence }));
      for (const h of t.holders.values()) {
        lines.push(JSON.stringify({
          t: 'grant', topic: name, lease: h.lease, name: h.name,
          fence: h.fence, since: h.since, expires: h.expires,
        }));
      }
    }
    const tmp = file + '.tmp';
    writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '');
    renameSync(tmp, file);
  }

  return { topics, append, compact, dataDir, file };
}

function replay(file, topics, nowMs) {
  const ensure = (name, capacity = 1) => {
    if (!topics.has(name)) topics.set(name, blankTopic(name, capacity));
    return topics.get(name);
  };

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch {
      console.error(`mutex: skipping corrupt line in ${file}`);
      continue;
    }
    if (rec.t === 'topic') {
      const t = ensure(rec.topic, rec.capacity);
      t.capacity = rec.capacity;
      t.fence = Math.max(t.fence, rec.fence ?? 0);
    } else if (rec.t === 'grant') {
      const t = ensure(rec.topic);
      t.fence = Math.max(t.fence, rec.fence);
      t.holders.set(rec.lease, {
        lease: rec.lease, name: rec.name, fence: rec.fence,
        since: rec.since, expires: rec.expires,
      });
    } else if (rec.t === 'renew') {
      const h = topics.get(rec.topic)?.holders.get(rec.lease);
      if (h) h.expires = rec.expires;
    } else if (rec.t === 'release') {
      topics.get(rec.topic)?.holders.delete(rec.lease);
    }
  }

  // Leases that died while we were down are simply gone.
  for (const t of topics.values()) {
    for (const [lease, h] of t.holders) {
      if (h.expires <= nowMs) t.holders.delete(lease);
    }
  }
}

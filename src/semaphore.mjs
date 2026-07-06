// Domain logic: counting semaphores with TTL leases, FIFO waiters, and
// per-topic monotonic fencing tokens. No HTTP in here — the server is a
// thin routing layer over this manager.

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { blankTopic } from './store.mjs';
import { MAX_TOPICS, MAX_WAITERS_PER_TOPIC } from './limits.mjs';

export class LockError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
  body() {
    return { error: this.message, code: this.code, ...this.extra };
  }
}

export function createManager({ store, now = Date.now } = {}) {
  return new LockManager(store, now);
}

class LockManager extends EventEmitter {
  constructor(store, now) {
    super();
    this.store = store;
    this.topics = store.topics;
    this.now = now;
    this.closed = false;
  }

  // ---- public API ---------------------------------------------------------

  /**
   * Acquire a permit. Resolves with a grant, or rejects with LockError:
   * 409 BUSY (full, no wait), 408 TIMEOUT (waited too long),
   * 409 CONFLICT (capacity disagreement), 429 (queue/topic limits).
   * Returns { promise, cancel } so the server can drop a waiter whose
   * client disconnected.
   */
  acquire({ topic: topicName, name, ttlMs, waitMs = 0, capacity = null }) {
    const topic = this.#ensureTopic(topicName, capacity);
    this.#sweep(topic);

    if (topic.holders.size < topic.capacity) {
      return { promise: Promise.resolve(this.#grant(topic, name, ttlMs)), cancel: () => {} };
    }

    if (waitMs <= 0) {
      const err = new LockError(409, 'BUSY', `"${topicName}" has no free permits`, this.#crowd(topic));
      return { promise: Promise.reject(err), cancel: () => {} };
    }

    if (this.#waiting(topic) >= MAX_WAITERS_PER_TOPIC) {
      const err = new LockError(429, 'WAITERS_LIMIT',
        `"${topicName}" already has ${MAX_WAITERS_PER_TOPIC} waiters`, this.#crowd(topic));
      return { promise: Promise.reject(err), cancel: () => {} };
    }

    const waiter = { name, ttlMs, settled: false, resolve: null, reject: null, timer: null };
    const promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    waiter.timer = setTimeout(() => {
      this.#unqueue(topic, waiter);
      waiter.reject(new LockError(408, 'TIMEOUT',
        `timed out after ${waitMs / 1000}s waiting for "${topicName}"`, this.#crowd(topic)));
    }, waitMs);
    topic.waiters.push(waiter);
    const cancel = () => this.#unqueue(topic, waiter);
    return { promise, cancel };
  }

  /** Heartbeat. Returns the updated grant view, or throws 404 if the lease is gone. */
  renew(topicName, lease, ttlMs) {
    const topic = this.topics.get(topicName);
    if (topic) this.#sweep(topic);
    const holder = topic?.holders.get(lease);
    if (!holder) {
      throw new LockError(404, 'NOT_FOUND',
        `no such lease on "${topicName}" — it expired or was released. Stop working.`);
    }
    holder.expires = this.now() + ttlMs;
    this.store.append({ t: 'renew', topic: topicName, lease, expires: holder.expires });
    this.#reschedule(topic);
    this.#emit('renew', topic, { name: holder.name, fence: holder.fence });
    return { topic: topicName, lease, name: holder.name, fence: holder.fence, expires: holder.expires };
  }

  /** Release. Throws 404 if the lease is gone (already expired or released). */
  release(topicName, lease) {
    const topic = this.topics.get(topicName);
    if (topic) this.#sweep(topic);
    const holder = topic?.holders.get(lease);
    if (!holder) {
      throw new LockError(404, 'NOT_FOUND',
        `no such lease on "${topicName}" — it expired or was already released`);
    }
    topic.holders.delete(lease);
    this.store.append({ t: 'release', topic: topicName, lease });
    this.#emit('release', topic, { name: holder.name, fence: holder.fence });
    this.#pump(topic);
    this.#reschedule(topic);
    return { topic: topicName, released: true, name: holder.name, fence: holder.fence };
  }

  /** Status. Never includes lease tokens. Unknown topics read as unused. */
  status(topicName) {
    const topic = this.topics.get(topicName);
    if (!topic) return { topic: topicName, capacity: null, holders: [], waiting: 0 };
    this.#sweep(topic);
    return {
      topic: topicName,
      capacity: topic.capacity,
      holders: this.#holderViews(topic),
      waiting: this.#waiting(topic),
    };
  }

  /** Clear all timers and fail all waiters; used on server shutdown. */
  close() {
    this.closed = true;
    for (const topic of this.topics.values()) {
      if (topic.timer) clearTimeout(topic.timer);
      topic.timer = null;
      for (const w of topic.waiters) {
        if (w.settled) continue;
        w.settled = true;
        clearTimeout(w.timer);
        w.reject(new LockError(503, 'SHUTDOWN', 'server shutting down'));
      }
      topic.waiters = [];
    }
  }

  // ---- internals ----------------------------------------------------------

  #ensureTopic(name, capacity) {
    const existing = this.topics.get(name);
    if (existing) {
      // All acquirers must agree on capacity; omitting it adopts the topic's.
      if (capacity !== null && capacity !== existing.capacity) {
        throw new LockError(409, 'CONFLICT',
          `"${name}" is a capacity=${existing.capacity} ${existing.capacity === 1 ? 'mutex' : 'semaphore'}, not capacity=${capacity}`,
          { capacity: existing.capacity });
      }
      return existing;
    }
    if (this.topics.size >= MAX_TOPICS) {
      throw new LockError(429, 'TOPIC_LIMIT', `topic limit reached (${MAX_TOPICS})`);
    }
    const topic = blankTopic(name, capacity ?? 1);
    this.topics.set(name, topic);
    this.store.append({ t: 'topic', topic: name, capacity: topic.capacity, fence: 0 });
    return topic;
  }

  #grant(topic, name, ttlMs) {
    const fence = ++topic.fence;
    const lease = randomBytes(16).toString('hex');
    const nowMs = this.now();
    const holder = {
      lease,
      name: name || `anon-${lease.slice(0, 6)}`,
      fence,
      since: nowMs,
      expires: nowMs + ttlMs,
    };
    topic.holders.set(lease, holder);
    this.store.append({
      t: 'grant', topic: topic.name, lease, name: holder.name,
      fence, since: holder.since, expires: holder.expires,
    });
    this.#reschedule(topic);
    this.#emit('grant', topic, { name: holder.name, fence });
    return {
      topic: topic.name,
      lease,
      name: holder.name,
      fence,
      expires: holder.expires,
      capacity: topic.capacity,
      holders: this.#holderViews(topic).map((h) => h.name),
    };
  }

  #sweep(topic) {
    const nowMs = this.now();
    for (const [lease, holder] of topic.holders) {
      if (holder.expires <= nowMs) {
        topic.holders.delete(lease);
        this.#emit('expire', topic, { name: holder.name, fence: holder.fence });
      }
    }
    this.#pump(topic);
    this.#reschedule(topic);
  }

  /** Hand freed permits to waiters, strictly FIFO. */
  #pump(topic) {
    while (topic.holders.size < topic.capacity && topic.waiters.length > 0) {
      const waiter = topic.waiters.shift();
      if (waiter.settled) continue;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      waiter.resolve(this.#grant(topic, waiter.name, waiter.ttlMs));
    }
  }

  #reschedule(topic) {
    if (topic.timer) clearTimeout(topic.timer);
    topic.timer = null;
    if (this.closed || topic.holders.size === 0) return;
    let next = Infinity;
    for (const h of topic.holders.values()) next = Math.min(next, h.expires);
    topic.timer = setTimeout(() => this.#sweep(topic), Math.max(0, next - this.now()));
  }

  #unqueue(topic, waiter) {
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    const i = topic.waiters.indexOf(waiter);
    if (i !== -1) topic.waiters.splice(i, 1);
  }

  #waiting(topic) {
    return topic.waiters.filter((w) => !w.settled).length;
  }

  #holderViews(topic) {
    return [...topic.holders.values()]
      .sort((a, b) => a.fence - b.fence)
      .map((h) => ({ name: h.name, since: h.since, expires: h.expires, fence: h.fence }));
  }

  #crowd(topic) {
    return { holders: this.#holderViews(topic).map((h) => h.name), waiting: this.#waiting(topic) };
  }

  #emit(event, topic, data) {
    this.emit('event', {
      event,
      topic: topic.name,
      data: {
        topic: topic.name,
        ...data,
        capacity: topic.capacity,
        holders: this.#holderViews(topic).map((h) => h.name),
        waiting: this.#waiting(topic),
      },
    });
  }
}

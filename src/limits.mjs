// All limits in one place. These are the free-tier / self-host defaults;
// the hosted Pro plan (see CONCEPT.md) relaxes some of them.

export const DEFAULT_PORT = 4185;

// Topics are created by first use and must match this.
export const TOPIC_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// TTLs are seconds; fractions allowed (handy for tests and short critical sections).
export const DEFAULT_TTL_SECONDS = 60;
export const MIN_TTL_SECONDS = 0.1;
export const MAX_TTL_SECONDS = 3600;

// Long-poll cap for ?wait=.
export const MAX_WAIT_SECONDS = 300;

// Semaphore size cap (capacity=1 is a mutex).
export const MAX_CAPACITY = 1024;

// A topic lives for the lifetime of the process (or data dir) so fencing
// tokens stay monotonic; this caps how many can exist.
export const MAX_TOPICS = 10_000;

// FIFO queue depth per topic.
export const MAX_WAITERS_PER_TOPIC = 1024;

// Request body (an optional plain-text holder name) and name length.
export const MAX_BODY_BYTES = 4096;
export const MAX_NAME_LENGTH = 128;

// SSE heartbeat comment interval.
export const SSE_HEARTBEAT_MS = 25_000;

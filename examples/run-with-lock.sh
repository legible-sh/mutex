#!/usr/bin/env sh
# The flock idiom: wrap any command in a lock with `mutex run`.
# Acquire -> heartbeat at ttl/3 -> run -> release. Kills the command if the
# lease is lost. Run a server first:  npx mutex-sh serve   (or: npm start)
set -eu

URL="${MUTEX_URL:-http://127.0.0.1:4185}"
TOPIC="deploy-demo-$$"
BIN="$(dirname "$0")/../bin/mutex.mjs"

echo "== two 'deploys' run concurrently; the lock serializes them"
node "$BIN" run "$TOPIC" --ttl 30 --url "$URL" -- \
  sh -c 'echo "deploy A: fence=$MUTEX_FENCE starting"; sleep 2; echo "deploy A: done"' &
sleep 0.3
node "$BIN" run "$TOPIC" --ttl 30 --url "$URL" -- \
  sh -c 'echo "deploy B: fence=$MUTEX_FENCE starting"; sleep 1; echo "deploy B: done"'
wait

echo
echo "== lock is free again"
curl -s "$URL/$TOPIC"
echo

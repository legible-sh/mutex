#!/usr/bin/env sh
# Counting semaphore: at most 3 agents against the staging environment.
# Run a server first:  npx mutex-sh serve   (or: npm start)
set -eu

URL="${MUTEX_URL:-http://127.0.0.1:4185}"
TOPIC="staging-env-demo-$$"

json_field() { sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" | head -1; }

echo "== three agents take the three staging permits (capacity=3)"
L1=$(curl -sf -X POST "$URL/$TOPIC?ttl=60&capacity=3" -H 'X-Name: agent-1' | json_field lease)
L2=$(curl -sf -X POST "$URL/$TOPIC?ttl=60&capacity=3" -H 'X-Name: agent-2' | json_field lease)
L3=$(curl -sf -X POST "$URL/$TOPIC?ttl=60&capacity=3" -H 'X-Name: agent-3' | json_field lease)
curl -s "$URL/$TOPIC"

echo
echo "== agent-4 bounces: no free permits"
curl -s -X POST "$URL/$TOPIC?ttl=60&capacity=3" -H 'X-Name: agent-4'

echo
echo "== declaring a different capacity is a 409 CONFLICT"
curl -s -X POST "$URL/$TOPIC?ttl=60&capacity=5" -H 'X-Name: confused-agent'

echo
echo "== agent-4 blocks with wait=10 while agent-1 finishes in 2s..."
( sleep 2; curl -s -X DELETE "$URL/$TOPIC/$L1" > /dev/null ) &
G4=$(curl -s -X POST "$URL/$TOPIC?ttl=60&capacity=3&wait=10" -H 'X-Name: agent-4')
echo "$G4"
wait
L4=$(echo "$G4" | json_field lease)

echo
echo "== clean up the remaining permits"
curl -s -X DELETE "$URL/$TOPIC/$L2" > /dev/null
curl -s -X DELETE "$URL/$TOPIC/$L3" > /dev/null
curl -s -X DELETE "$URL/$TOPIC/$L4" > /dev/null
curl -s "$URL/$TOPIC"
echo

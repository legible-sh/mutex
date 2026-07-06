#!/usr/bin/env sh
# Two workers race to migrate the same database; the fence keeps the loser out.
# Run a server first:  npx mutex-sh serve   (or: npm start)
set -eu

URL="${MUTEX_URL:-http://127.0.0.1:4185}"
TOPIC="migrate-prod-db-demo-$$"

json_field() { sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" | head -1; }

echo "== worker-1 acquires the migration lock"
GRANT=$(curl -sf -X POST "$URL/$TOPIC?ttl=60" -H 'X-Name: worker-1')
echo "$GRANT"
LEASE=$(echo "$GRANT" | json_field lease)
FENCE=$(echo "$GRANT" | json_field fence)

echo
echo "== worker-2 tries the same lock and bounces (409)"
curl -s -X POST "$URL/$TOPIC?ttl=60" -H 'X-Name: worker-2'

echo
echo "== the fencing pattern: stamp the resource with fence=$FENCE"
echo "   e.g. UPDATE migration_state SET fence = $FENCE WHERE fence < $FENCE"
echo "   (0 rows updated would mean a newer holder already wrote — stop)"

echo
echo "== worker-1 heartbeats mid-migration"
curl -s -X POST "$URL/$TOPIC/$LEASE/renew?ttl=60"

echo
echo "== anyone can check status (no lease tokens shown)"
curl -s "$URL/$TOPIC"

echo
echo "== worker-1 finishes and releases"
curl -s -X DELETE "$URL/$TOPIC/$LEASE"

echo
echo "== now worker-2 gets it — with a higher fence"
curl -s -X POST "$URL/$TOPIC?ttl=60" -H 'X-Name: worker-2'
echo

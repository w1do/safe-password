#!/bin/sh
# Restores the database and encryption key from a backup made by scripts/backup.sh.
# Current data in the volumes is REPLACED.
# Usage: scripts/restore.sh <backup-dir>
set -eu
DIR="${1:?Usage: scripts/restore.sh <backup-dir>}"
test -s "$DIR/vault.sqlite" || { echo "$DIR/vault.sqlite not found" >&2; exit 1; }
test -s "$DIR/master.key" || { echo "$DIR/master.key not found" >&2; exit 1; }
DIR="$(cd "$DIR" && pwd)"

docker compose stop vault
docker compose run --rm --no-deps -T -v "$DIR:/backup:ro" --entrypoint sh vault -c '
  set -e
  rm -f /data/db/vault.sqlite /data/db/vault.sqlite-wal /data/db/vault.sqlite-shm
  cp /backup/vault.sqlite /data/db/vault.sqlite
  cp /backup/master.key /data/config/master.key
  chmod 600 /data/db/vault.sqlite /data/config/master.key
'
docker compose up -d vault
echo "Restored from $DIR. Log in with the credentials and token that were valid when the backup was taken." >&2

#!/bin/sh
# Backs up the database AND the encryption key. Without master.key the backup cannot be decrypted.
# Usage: scripts/backup.sh [output-dir]
set -eu
OUT="${1:-./backups/vault-$(date +%Y%m%d-%H%M%S)}"
umask 077
mkdir -p "$OUT"

docker compose exec -T vault node server/dist/backup.js > "$OUT/vault.sqlite"
docker compose exec -T vault cat /data/config/master.key > "$OUT/master.key"

test -s "$OUT/vault.sqlite" && test -s "$OUT/master.key"
echo "Backup written to $OUT (vault.sqlite + master.key). Store it encrypted and offline." >&2

#!/bin/bash
# Pre-backup hook for Duplicati — snapshots every non-system MySQL database,
# and each Ghost site's analytics events, into /data/db_dumps so the backup
# job picks them up alongside the content volumes.
#
# Requires: MYSQL_HOST, MYSQL_PORT (optional, default 3306), MYSQL_ROOT_PASSWORD.
# Optional: CLICKHOUSE_URL (+ CLICKHOUSE_DATABASE/USER/PASSWORD) — without it
# the analytics step is skipped and only the SQL dumps are written.
#
# Nothing here is compressed. Duplicati deduplicates on fixed-size blocks of
# each source file, so a plain dump costs only the blocks that changed since
# the last run (and nothing at all for an untouched database), while a gzipped
# one differs from end to end and is stored again in full every single hour.
# Duplicati compresses its own volumes, so the backup is no larger for it.
set -euo pipefail

# Duplicati runs --run-script-before ahead of every operation on the job, not
# only a backup: a restore, a fileset listing, even a search in the Backups
# tab. Dumping then costs a full mysqldump of every database per request and,
# worse, empties and rewrites /data/db_dumps under a backup that is reading
# it — which is how a version ends up with a site's SQL dump but not its
# analytics. Run by hand (no operation name), it still dumps.
if [[ "${DUPLICATI__OPERATIONNAME:-Backup}" != "Backup" ]]; then
  exit 0
fi

DUMP_DIR="/data/db_dumps"
MYSQL_HOST="${MYSQL_HOST:-mysql}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
CLICKHOUSE_URL="${CLICKHOUSE_URL:-}"
CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-ghost_analytics}"

if [[ -z "${MYSQL_ROOT_PASSWORD:-}" ]]; then
  echo "ERROR: MYSQL_ROOT_PASSWORD is not set" >&2
  exit 1
fi

if ! command -v mysqldump &>/dev/null; then
  echo "ERROR: mysqldump not found — is the image built correctly?" >&2
  exit 1
fi

# One site's analytics events, as JSONEachRow, ordered so that the file only
# ever grows at the end: an hourly backup then stores just the new tail
# instead of a file whose every block shifted. Failures are reported by the
# caller, which keeps going — analytics must never fail a backup.
dump_analytics() {
  local site_uuid="$1" dest="$2"
  local query="SELECT * FROM analytics_events WHERE site_uuid = {site_uuid:String} ORDER BY inserted_at, timestamp, session_id FORMAT JSONEachRow"
  local -a auth=()

  # ClickHouse rejects a key without a user, so a password alone means the
  # default user.
  if [[ -n "${CLICKHOUSE_USER:-}" || -n "${CLICKHOUSE_PASSWORD:-}" ]]; then
    auth+=(-H "X-ClickHouse-User: ${CLICKHOUSE_USER:-default}")
  fi

  if [[ -n "${CLICKHOUSE_PASSWORD:-}" ]]; then
    auth+=(-H "X-ClickHouse-Key: ${CLICKHOUSE_PASSWORD}")
  fi

  curl -sS --fail-with-body --max-time 1800 \
    --get "${CLICKHOUSE_URL}" \
    --data-urlencode "database=${CLICKHOUSE_DATABASE}" \
    --data-urlencode "param_site_uuid=${site_uuid}" \
    --data-urlencode "query=${query}" \
    "${auth[@]}" \
    -o "$dest"
}

# Ghost's site_uuid setting is what keys the site's rows in ClickHouse.
site_uuid_of() {
  local db="$1"
  {
    mysql "${MYSQL_ARGS[@]}" --skip-column-names --batch \
      -e "SELECT value FROM \`${db}\`.settings WHERE \`key\` = 'site_uuid' LIMIT 1" 2>/dev/null \
      || true
  } | head -n1
}

# Fresh dump dir each run so Duplicati always sees a clean snapshot.
# /data/db_dumps is a bind mount so we can't rm the dir itself — clear contents only.
mkdir -p "$DUMP_DIR"
find "$DUMP_DIR" -mindepth 1 -delete

MYSQL_ARGS=(-h "$MYSQL_HOST" -P "$MYSQL_PORT" -u root -p"$MYSQL_ROOT_PASSWORD")

databases=$(mysql "${MYSQL_ARGS[@]}" --skip-column-names -e "SHOW DATABASES;" 2>/dev/null \
  | grep -Ev "^(information_schema|performance_schema|mysql|sys)$")

if [[ -z "$databases" ]]; then
  echo "No user databases found — nothing to dump."
  exit 0
fi

if [[ -z "$CLICKHOUSE_URL" ]]; then
  echo "CLICKHOUSE_URL is not set — backing up databases only, without analytics."
fi

failed=0
for db in $databases; do
  echo "Dumping $db..."
  if mysqldump "${MYSQL_ARGS[@]}" \
      --single-transaction --quick --lock-tables=false \
      "$db" > "$DUMP_DIR/${db}.sql"; then
    echo "  -> $DUMP_DIR/${db}.sql ($(du -h "$DUMP_DIR/${db}.sql" | cut -f1))"
  else
    echo "  ERROR: failed to dump $db" >&2
    rm -f "$DUMP_DIR/${db}.sql"
    failed=1
    continue
  fi

  # Analytics are best-effort: a database that is not a Ghost site, a site
  # that has never been visited, or an unreachable ClickHouse all just mean
  # this backup version has no analytics for it. $failed is deliberately not
  # touched — the site's own data is already safely dumped above.
  [[ -n "$CLICKHOUSE_URL" ]] || continue

  site_uuid="$(site_uuid_of "$db")"

  if [[ -z "$site_uuid" ]]; then
    continue
  fi

  echo "  Dumping analytics for $db (site $site_uuid)..."
  if dump_analytics "$site_uuid" "$DUMP_DIR/${db}.analytics.jsonl"; then
    echo "  -> $DUMP_DIR/${db}.analytics.jsonl ($(wc -l < "$DUMP_DIR/${db}.analytics.jsonl") events)"
  else
    echo "  WARNING: failed to dump analytics for $db" >&2
    rm -f "$DUMP_DIR/${db}.analytics.jsonl"
  fi
done

exit $failed

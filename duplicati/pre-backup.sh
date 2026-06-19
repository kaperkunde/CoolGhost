#!/bin/bash
# Pre-backup hook for Duplicati — dumps every non-system MySQL database to /data/db_dumps.
# Requires: MYSQL_HOST, MYSQL_PORT (optional, default 3306), MYSQL_ROOT_PASSWORD env vars.
set -euo pipefail

DUMP_DIR="/data/db_dumps"
MYSQL_HOST="${MYSQL_HOST:-mysql}"
MYSQL_PORT="${MYSQL_PORT:-3306}"

if [[ -z "${MYSQL_ROOT_PASSWORD:-}" ]]; then
  echo "ERROR: MYSQL_ROOT_PASSWORD is not set" >&2
  exit 1
fi

if ! command -v mysqldump &>/dev/null; then
  echo "ERROR: mysqldump not found — is the image built correctly?" >&2
  exit 1
fi

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

failed=0
for db in $databases; do
  echo "Dumping $db..."
  if mysqldump "${MYSQL_ARGS[@]}" \
      --single-transaction --quick --lock-tables=false \
      "$db" | gzip > "$DUMP_DIR/${db}.sql.gz"; then
    echo "  -> $DUMP_DIR/${db}.sql.gz ($(du -h "$DUMP_DIR/${db}.sql.gz" | cut -f1))"
  else
    echo "  ERROR: failed to dump $db" >&2
    rm -f "$DUMP_DIR/${db}.sql.gz"
    failed=1
  fi
done

exit $failed

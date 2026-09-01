#!/bin/bash
# First-run provisioning for the CoolGhost Duplicati stack.
#
# Duplicati ships with no backup jobs, so a fresh Coolify deploy leaves the
# GhostHost API with nothing to list or restore from. This script waits for the
# Duplicati web service to come up and — only if the jobs are missing — creates
# the two stock jobs the rest of the stack expects:
#
#   CoolGhost Hourly   every hour, keeps 24h,  -> file:///backups/hourly
#   CoolGhost Daily    every day,  keeps 15d,  -> file:///backups/daily
#
# Both back up the paths the API's recovery/index flows look for, and both run
# pre-backup.sh so a fresh SQL dump of every site database is captured in the
# same snapshot as the content volumes.
#
# It is idempotent: a marker in /config (a persistent mount) plus a name check
# against the live job list means restarts and redeploys never duplicate jobs,
# and jobs a human has since edited or deleted are left alone.
set -uo pipefail

LOG_FILE="${DUPLICATI_BOOTSTRAP_LOG:-/config/coolghost-bootstrap.log}"
MARKER_FILE="${DUPLICATI_BOOTSTRAP_MARKER:-/config/coolghost-bootstrap.json}"
API="${DUPLICATI_BOOTSTRAP_URL:-http://127.0.0.1:8200}"

HOURLY_NAME="${DUPLICATI_HOURLY_NAME:-CoolGhost Hourly}"
DAILY_NAME="${DUPLICATI_DAILY_NAME:-CoolGhost Daily}"

# Local disk by default. Point the daily job at remote storage (S3, B2, ...) by
# setting DUPLICATI_DAILY_TARGET_URL to any Duplicati backend URL.
HOURLY_TARGET_URL="${DUPLICATI_HOURLY_TARGET_URL:-file:///backups/hourly}"
DAILY_TARGET_URL="${DUPLICATI_DAILY_TARGET_URL:-file:///backups/daily}"

HOURLY_KEEP_TIME="${DUPLICATI_HOURLY_KEEP_TIME:-24h}"
DAILY_KEEP_TIME="${DUPLICATI_DAILY_KEEP_TIME:-15D}"

HOURLY_REPEAT="${DUPLICATI_HOURLY_REPEAT:-1h}"
DAILY_REPEAT="${DUPLICATI_DAILY_REPEAT:-1D}"
# Wall-clock time (container TZ) the daily job is anchored to.
DAILY_AT="${DUPLICATI_DAILY_AT:-03:30}"

# Sources are colon-separated, matching how Duplicati itself joins path lists.
# The hourly job carries exactly what the API needs to rebuild a site; the
# daily job additionally carries the Coolify state needed to rebuild the host.
HOURLY_SOURCES="${DUPLICATI_HOURLY_SOURCES:-/local/volumes/:/data/db_dumps/}"
DAILY_SOURCES="${DUPLICATI_DAILY_SOURCES:-/local/volumes/:/data/db_dumps/:/data/coolify/}"

# Excluded from both jobs. /local/volumes is the host's whole docker volume
# root, so it also holds live database files: those are huge, and a file-level
# copy of a running database is not restorable anyway. The real database
# content arrives as consistent dumps via pre-backup.sh instead.
# backingFsBlockDev is a block device docker keeps in that directory.
DEFAULT_EXCLUDES='*mysql-data/*:*clickhouse-data/*:*/backingFsBlockDev:*/metadata.db:/data/coolify/backups/*:*/.cache/*'
EXCLUDES="${DUPLICATI_BOOTSTRAP_EXCLUDES:-$DEFAULT_EXCLUDES}"

RUN_NOW="${DUPLICATI_BOOTSTRAP_RUN_NOW:-true}"
WAIT_SECONDS="${DUPLICATI_BOOTSTRAP_WAIT_SECONDS:-300}"

# The container's stdout, so progress shows up in `docker logs`. Deliberately
# not this script's stdout, which callers capture.
CONTAINER_STDOUT=/proc/1/fd/1
[[ -w "$CONTAINER_STDOUT" ]] || CONTAINER_STDOUT=/dev/stderr

log() {
  local line
  line="[coolghost-bootstrap] $(date -Is) $*"
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null
  echo "$line" >>"$LOG_FILE" 2>/dev/null
  echo "$line" >"$CONTAINER_STDOUT" 2>/dev/null || true
}

die() {
  log "ERROR: $*"
  log "Bootstrap aborted; no marker written, so it will retry on next start."
  exit 1
}

if [[ "${DUPLICATI_BOOTSTRAP_ENABLED:-true}" != "true" ]]; then
  log "DUPLICATI_BOOTSTRAP_ENABLED is not 'true' — skipping backup provisioning."
  exit 0
fi

if [[ -f "$MARKER_FILE" && "${DUPLICATI_BOOTSTRAP_FORCE:-false}" != "true" ]]; then
  log "Already bootstrapped ($MARKER_FILE exists) — nothing to do."
  exit 0
fi

PASSWORD="${DUPLICATI__WEBSERVICE_PASSWORD:-${DUPLICATI_WEBSERVICE_PASSWORD:-}}"
[[ -n "$PASSWORD" ]] || die "DUPLICATI__WEBSERVICE_PASSWORD is not set — cannot log in to the Duplicati API."

# Backups are useless if the passphrase is lost, so require an explicit one
# rather than inventing a random secret nobody has a copy of.
PASSPHRASE="${DUPLICATI_BACKUP_PASSPHRASE:-${SETTINGS_ENCRYPTION_KEY:-}}"
if [[ -n "$PASSPHRASE" ]]; then
  ENCRYPTION_MODULE="aes"
else
  ENCRYPTION_MODULE=""
  log "WARNING: neither DUPLICATI_BACKUP_PASSPHRASE nor SETTINGS_ENCRYPTION_KEY is set — creating UNENCRYPTED backups."
fi

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found — is the image built from duplicati/Dockerfile?"
done

# --- wait for the web service ------------------------------------------------

log "Waiting up to ${WAIT_SECONDS}s for the Duplicati web service at $API ..."
deadline=$((SECONDS + WAIT_SECONDS))
until curl -fsS -o /dev/null --max-time 5 "$API/api/v1/serverstate" 2>/dev/null \
  || curl -fsS -o /dev/null --max-time 5 "$API/" 2>/dev/null; do
  if ((SECONDS >= deadline)); then
    die "Duplicati web service did not come up within ${WAIT_SECONDS}s."
  fi
  sleep 3
done
log "Duplicati web service is up."

# --- authenticate ------------------------------------------------------------

login_response=$(curl -fsS --max-time 20 \
  -H 'Content-Type: application/json' \
  -X POST "$API/api/v1/auth/login" \
  -d "$(jq -nc --arg p "$PASSWORD" '{Password: $p, RememberMe: false}')") \
  || die "Login request to the Duplicati API failed."

TOKEN=$(jq -r '.AccessToken // empty' <<<"$login_response")
[[ -n "$TOKEN" ]] || die "Duplicati login returned no access token (is DUPLICATI__WEBSERVICE_PASSWORD correct?)."
log "Authenticated against the Duplicati API."

api_get() {
  curl -fsS --max-time 30 -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' "$API$1"
}

api_post() {
  # $1 = path, $2 = body (omit for empty POST)
  if [[ $# -ge 2 ]]; then
    curl -fsS --max-time 60 -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' -H 'Accept: application/json' \
      -X POST "$API$1" -d "$2"
  else
    curl -fsS --max-time 60 -H "Authorization: Bearer $TOKEN" \
      -H 'Accept: application/json' -X POST "$API$1"
  fi
}

existing=$(api_get "/api/v1/backups") || die "Could not list existing backup jobs."
existing_names=$(jq -r '[.[].Backup.Name // empty] | .[]' <<<"$existing")

if [[ -n "$existing_names" ]]; then
  log "Existing backup jobs: $(tr '\n' ',' <<<"$existing_names" | sed 's/,$//')"
fi

# --- payload construction ----------------------------------------------------

# Duplicati anchors a schedule to Time and then repeats. Give the hourly job a
# full period of headroom so it does not collide with the immediate first run
# below, and anchor the daily job to a quiet wall-clock hour.
hourly_time=$(date -u -d "+1 hour" +%Y-%m-%dT%H:%M:%SZ)

# DAILY_AT is wall-clock time in the container's TZ, so resolve it to an epoch
# in local time first and only then format as UTC — `date -u -d "03:30"` would
# read the 03:30 as UTC and silently shift the job by the TZ offset.
daily_epoch=$(date -d "today $DAILY_AT" +%s 2>/dev/null) \
  || die "DUPLICATI_DAILY_AT ('$DAILY_AT') is not a time that 'date' understands."
if ((daily_epoch <= $(date +%s))); then
  daily_epoch=$(date -d "tomorrow $DAILY_AT" +%s)
fi
daily_time=$(date -u -d "@$daily_epoch" +%Y-%m-%dT%H:%M:%SZ)

# Duplicati matches filter expressions against the full path, anchored, with
# '*' expanding to '.*' — so `*mysql-data/*` matches both the directory itself
# (pruning the walk) and everything beneath it.
filters_json() {
  jq -nc --arg excludes "$EXCLUDES" '
    ($excludes | split(":") | map(select(length > 0)))
    | to_entries
    | map({Order: .key, Include: false, Expression: .value})
  '
}

backup_payload() {
  local name="$1" description="$2" target_url="$3" sources="$4" keep_time="$5" repeat="$6" time="$7"

  jq -nc \
    --arg name "$name" \
    --arg description "$description" \
    --arg targetUrl "$target_url" \
    --arg sources "$sources" \
    --arg keepTime "$keep_time" \
    --arg repeat "$repeat" \
    --arg time "$time" \
    --arg encryptionModule "$ENCRYPTION_MODULE" \
    --arg passphrase "$PASSPHRASE" \
    --arg preBackup "${DUPLICATI_PRE_BACKUP_SCRIPT:-/usr/local/bin/pre-backup.sh}" \
    --arg scriptTimeout "${DUPLICATI_PRE_BACKUP_TIMEOUT:-30m}" \
    --argjson filters "$(filters_json)" \
    '
    def settings:
      [
        {Name: "encryption-module", Value: $encryptionModule, Filter: ""},
        {Name: "compression-module", Value: "zip",            Filter: ""},
        {Name: "dblock-size",        Value: "50mb",           Filter: ""},
        {Name: "keep-time",          Value: $keepTime,        Filter: ""},
        {Name: "--run-script-before",  Value: $preBackup,     Filter: ""},
        {Name: "--run-script-timeout", Value: $scriptTimeout, Filter: ""},
        {Name: "--auto-cleanup",       Value: "true",         Filter: ""},
        {Name: "--number-of-retries",  Value: "5",            Filter: ""},
        # Duplicati fails a whole backup on a missing source by default. A
        # deploy without every optional mount (/data/coolify on a non-Coolify
        # host, say) should still capture the volumes and dumps it does have.
        {Name: "--allow-missing-source", Value: "true",       Filter: ""}
      ]
      + (if $encryptionModule == "" then
           [{Name: "--no-encryption", Value: "true", Filter: ""}]
         else
           [{Name: "passphrase", Value: $passphrase, Filter: ""}]
         end);

    {
      Backup: {
        Name: $name,
        Description: $description,
        Tags: ["coolghost"],
        TargetURL: $targetUrl,
        Sources: ($sources | split(":") | map(select(length > 0))),
        Settings: settings,
        Filters: $filters,
        Metadata: {}
      },
      Schedule: {
        Repeat: $repeat,
        Time: $time,
        AllowedDays: []
      }
    }
    '
}

# Duplicati's file backend fails a backup outright if the destination folder is
# missing (the web UI normally offers to create it), so make local targets
# exist before the job is defined. Remote backends create their own containers.
ensure_local_target() {
  local url="$1" dir

  [[ "$url" == file://* ]] || return 0

  dir="${url#file://}"
  dir="${dir%%\?*}"
  [[ -n "$dir" ]] || return 0

  if mkdir -p "$dir" 2>/dev/null; then
    log "Backup destination $dir is ready."
  else
    log "WARNING: could not create the backup destination $dir — is /backups mounted and writable?"
  fi
}

ensure_local_target "$HOURLY_TARGET_URL"
ensure_local_target "$DAILY_TARGET_URL"

created_names=()
# Set by ensure_backup to the id of a job it just created (empty when the job
# already existed) — returned this way rather than on stdout so the call does
# not need a subshell, which would drop created_names.
ENSURED_ID=""

ensure_backup() {
  local name="$1" target_url="$3"
  ENSURED_ID=""

  if grep -Fxq "$name" <<<"$existing_names"; then
    log "Job '$name' already exists — leaving it untouched."
    return 0
  fi

  local payload
  if ! payload=$(backup_payload "$@"); then
    log "ERROR: could not build the payload for '$name'."
    return 1
  fi

  local response
  if ! response=$(api_post "/api/v1/backups" "$payload" 2>&1); then
    log "ERROR: creating job '$name' failed: $response"
    return 1
  fi

  local id
  id=$(jq -r '.ID // .Id // empty' <<<"$response" 2>/dev/null)
  if [[ -z "$id" ]]; then
    log "ERROR: creating job '$name' returned no id: $response"
    return 1
  fi

  log "Created job '$name' (id $id) -> $target_url"
  created_names+=("$name")
  ENSURED_ID="$id"
  return 0
}

failures=0

ensure_backup \
  "$HOURLY_NAME" \
  "Hourly CoolGhost backup: Ghost content volumes + MySQL dumps, kept for $HOURLY_KEEP_TIME. Created automatically on first deploy." \
  "$HOURLY_TARGET_URL" "$HOURLY_SOURCES" "$HOURLY_KEEP_TIME" "$HOURLY_REPEAT" "$hourly_time" || failures=1
hourly_id="$ENSURED_ID"

ensure_backup \
  "$DAILY_NAME" \
  "Daily CoolGhost backup: Ghost content volumes + MySQL dumps + Coolify state, kept for $DAILY_KEEP_TIME. Created automatically on first deploy." \
  "$DAILY_TARGET_URL" "$DAILY_SOURCES" "$DAILY_KEEP_TIME" "$DAILY_REPEAT" "$daily_time" || failures=1

# A brand-new stack has no restorable version until something runs, which makes
# the GhostHost restore picker look broken. Kick the hourly job once so there is
# a real snapshot (and so a misconfiguration surfaces now, not in an hour).
if [[ "$RUN_NOW" == "true" && -n "${hourly_id:-}" ]]; then
  if api_post "/api/v1/backup/$hourly_id/run" >/dev/null 2>&1; then
    log "Queued an initial run of '$HOURLY_NAME'."
  else
    log "WARNING: could not queue the initial run of '$HOURLY_NAME'; it will run on schedule."
  fi
fi

if ((failures)); then
  die "One or more jobs could not be created."
fi

jq -n \
  --arg bootstrappedAt "$(date -Is)" \
  --arg hourly "$HOURLY_NAME" \
  --arg daily "$DAILY_NAME" \
  '$ARGS.positional as $created
   | {bootstrappedAt: $bootstrappedAt,
      created: $created,
      jobs: {hourly: $hourly, daily: $daily},
      note: "Delete this file (or set DUPLICATI_BOOTSTRAP_FORCE=true) to let the bootstrap run again."}' \
  --args "${created_names[@]+"${created_names[@]}"}" \
  >"$MARKER_FILE" || die "Could not write the marker file $MARKER_FILE."

log "Bootstrap complete. Marker written to $MARKER_FILE."

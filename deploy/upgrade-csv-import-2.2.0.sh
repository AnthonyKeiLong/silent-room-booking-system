#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SERVICE='silent-booth-booking'
APP_DIR='/var/www/anthonyapp'
ENV_FILE='/etc/silent-booth-booking.env'
BACKUP_DIR='/var/backups/silent-booth-booking'
EXPECTED_STAGE='/home/anthony/silent-booth-booking-nodeapp-2.2.0-stage'

SUCCESS=0
SERVICE_TRANSITION=0
STAMP=''
RELEASE=''
ROLLBACK=''
FAILED=''

log() {
  printf '%s\n' "$*"
}

wait_for_health() {
  local path="$1"
  local attempt

  for attempt in $(seq 1 20); do
    if curl --fail --silent --show-error \
      --connect-timeout 2 --max-time 3 \
      "http://127.0.0.1:3000${path}" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

verify_prefix_redirect() {
  local headers status location

  if ! headers="$(curl --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    --output /dev/null --dump-header - \
    http://127.0.0.1:3000/nodeapp)"; then
    return 1
  fi

  headers="${headers//$'\r'/}"
  status="$(awk 'NR == 1 { print $2; exit }' <<<"$headers")"
  location="$(awk '
    tolower($1) == "location:" {
      $1 = ""
      sub(/^[[:space:]]+/, "")
      print
      exit
    }
  ' <<<"$headers")"

  if [[ "$status" != '308' || "$location" != '/nodeapp/' ]]; then
    log 'Expected /nodeapp to return 308 and Location: /nodeapp/.'
    log "Observed status=${status:-missing}, location=${location:-missing}"
    return 1
  fi
}

verify_import_feature() {
  local admin_page status

  if ! admin_page="$(curl --fail --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    http://127.0.0.1:3000/nodeapp/admin.html)"; then
    return 1
  fi
  if ! grep -q 'id="studentCsvPanel"' <<<"$admin_page"; then
    log 'The deployed administrator page does not contain the CSV import panel.'
    return 1
  fi

  status="$(curl --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    --output /dev/null --write-out '%{http_code}' \
    --request POST \
    --header 'Content-Type: text/csv; charset=utf-8' \
    --data-binary 'email,password,display_name' \
    http://127.0.0.1:3000/nodeapp/api/admin/users/import)"

  if [[ "$status" != '401' ]]; then
    log 'The protected CSV import endpoint did not return the expected 401 response.'
    log "Observed status=${status:-missing}"
    return 1
  fi
}

restore_on_exit() {
  local exit_code=$?
  trap - EXIT HUP INT TERM

  if [[ "$SUCCESS" -eq 1 ]]; then
    exit "$exit_code"
  fi

  if [[ "$SERVICE_TRANSITION" -eq 1 ]]; then
    log 'Upgrade did not complete; attempting automatic rollback.'

    if ! systemctl stop "$SERVICE"; then
      log 'CRITICAL: could not stop the service; no rollback files were moved.'
      exit "$exit_code"
    fi

    if [[ -n "$ROLLBACK" && -d "$ROLLBACK" ]]; then
      if [[ -e "$APP_DIR" ]]; then
        if [[ -z "$FAILED" || -e "$FAILED" ]] || \
           ! mv -- "$APP_DIR" "$FAILED"; then
          log "CRITICAL: could not retain the failed release at $FAILED"
          exit "$exit_code"
        fi
      fi

      if [[ ! -e "$APP_DIR" ]] && ! mv -- "$ROLLBACK" "$APP_DIR"; then
        log "CRITICAL: could not restore the previous release from $ROLLBACK"
        exit "$exit_code"
      fi
    fi

    if [[ ! -d "$APP_DIR" ]]; then
      log "CRITICAL: live application directory is absent: $APP_DIR"
      exit "$exit_code"
    fi

    if ! systemctl start "$SERVICE"; then
      log 'CRITICAL: the previous release was restored but did not start.'
      exit "$exit_code"
    fi

    if ! wait_for_health '/api/health'; then
      log 'CRITICAL: the restored release did not pass its local health check.'
      exit "$exit_code"
    fi

    log 'Previous release restored and local health check passed.'
    if [[ -n "$FAILED" && -e "$FAILED" ]]; then
      log "Failed release retained at: $FAILED"
    fi
  fi

  exit "$exit_code"
}

trap restore_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$EUID" -ne 0 ]]; then
  log 'Run this script as root.'
  exit 1
fi

if [[ $# -ne 1 ]]; then
  log "Usage: $0 $EXPECTED_STAGE"
  exit 1
fi

STAGE="$(realpath -e -- "$1")"
if [[ "$STAGE" != "$EXPECTED_STAGE" ]]; then
  log "STOP: unexpected staging path: $STAGE"
  exit 1
fi

for required_path in \
  "$STAGE/server.js" \
  "$STAGE/app-base-path.js" \
  "$STAGE/cookie.js" \
  "$STAGE/package.json" \
  "$STAGE/package-lock.json" \
  "$STAGE/public/admin.html" \
  "$STAGE/public/admin.js" \
  "$STAGE/public/student-csv-import.js" \
  "$STAGE/scripts/check-database.js" \
  "$STAGE/scripts/check-student-csv-import.js" \
  "$STAGE/node_modules"; do
  if [[ ! -e "$required_path" ]]; then
    log "STOP: staged release is incomplete: $required_path"
    exit 1
  fi
done

if ! /usr/bin/node -e \
  "const p=require(process.argv[1]); process.exit(p.version === '2.2.0' ? 0 : 1)" \
  "$STAGE/package.json"; then
  log 'STOP: staged package version is not 2.2.0.'
  exit 1
fi

if [[ ! -d "$APP_DIR" || -L "$APP_DIR" ]]; then
  log "STOP: live application path is not the expected directory: $APP_DIR"
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  log "STOP: protected environment file is absent: $ENV_FILE"
  exit 1
fi
base_path_count="$(grep -c '^APP_BASE_PATH=' "$ENV_FILE" || true)"
if [[ "$base_path_count" != '1' ]] || \
   ! grep -qx 'APP_BASE_PATH=/nodeapp' "$ENV_FILE"; then
  log 'STOP: the protected environment must contain exactly one APP_BASE_PATH=/nodeapp line.'
  exit 1
fi
if ! systemctl is-active --quiet "$SERVICE"; then
  log "STOP: $SERVICE is not active before the upgrade."
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE="/var/www/anthonyapp-release-${STAMP}"
ROLLBACK="/var/www/anthonyapp-rollback-${STAMP}"
FAILED="/var/www/anthonyapp-failed-${STAMP}"
APP_BACKUP="$BACKUP_DIR/app-before-csv-import-2.2.0-${STAMP}.tar.gz"
ENV_BACKUP="$BACKUP_DIR/environment-before-csv-import-2.2.0-${STAMP}.env"
DB_BACKUP="$BACKUP_DIR/database-before-csv-import-2.2.0-${STAMP}.sql.gz"

for new_path in \
  "$RELEASE" "$ROLLBACK" "$FAILED" \
  "$APP_BACKUP" "$ENV_BACKUP" "$DB_BACKUP"; do
  if [[ -e "$new_path" ]]; then
    log "STOP: generated path already exists: $new_path"
    exit 1
  fi
done

install -d -m 0700 -o root -g root "$BACKUP_DIR"

tar -C /var/www -czf "$APP_BACKUP" anthonyapp
test -s "$APP_BACKUP"
tar -tzf "$APP_BACKUP" >/dev/null
chmod 0600 "$APP_BACKUP"
chown root:root "$APP_BACKUP"

cp -a -- "$ENV_FILE" "$ENV_BACKUP"
test -s "$ENV_BACKUP"
cmp --silent "$ENV_FILE" "$ENV_BACKUP"
chmod 0600 "$ENV_BACKUP"
chown root:root "$ENV_BACKUP"

(
  umask 077
  mariadb-dump --single-transaction --routines --triggers --events \
    silent_booth_booking | gzip -9 > "$DB_BACKUP"
)
test -s "$DB_BACKUP"
gzip -t "$DB_BACKUP"
chmod 0600 "$DB_BACKUP"
chown root:root "$DB_BACKUP"

install -d -m 2750 -o anthony -g silentbooth "$RELEASE"
cp -a -- "$STAGE/." "$RELEASE/"
chown -R anthony:silentbooth "$RELEASE"

find "$RELEASE" \
  -path "$RELEASE/node_modules" -prune -o \
  -type d -exec chmod 2750 {} +
find "$RELEASE" \
  -path "$RELEASE/node_modules" -prune -o \
  -type f -exec chmod 0640 {} +
chmod -R g-w,o-rwx "$RELEASE/node_modules"
chmod -R g+rX "$RELEASE/node_modules"

runuser -u silentbooth -- test -r "$RELEASE/server.js"
runuser -u silentbooth -- test ! -w "$RELEASE/server.js"
runuser -u silentbooth -- /usr/bin/node \
  --env-file="$ENV_FILE" \
  "$RELEASE/scripts/check-database.js"

SERVICE_TRANSITION=1
systemctl stop "$SERVICE"
mv -- "$APP_DIR" "$ROLLBACK"
mv -- "$RELEASE" "$APP_DIR"
systemctl start "$SERVICE"

if ! wait_for_health '/api/health'; then
  log 'New release failed the direct local health check.'
  exit 1
fi
if ! wait_for_health '/nodeapp/api/health'; then
  log 'New release failed the /nodeapp local health check.'
  exit 1
fi
if ! verify_prefix_redirect; then
  log 'New release failed the exact-prefix redirect check.'
  exit 1
fi
if ! verify_import_feature; then
  log 'New release failed the CSV import feature check.'
  exit 1
fi

systemctl is-active "$SERVICE"
curl --fail --silent --show-error \
  --connect-timeout 2 --max-time 5 \
  http://127.0.0.1:3000/api/health
printf '\n'
curl --fail --silent --show-error \
  --connect-timeout 2 --max-time 5 \
  http://127.0.0.1:3000/nodeapp/api/health
printf '\n'

SUCCESS=1
SERVICE_TRANSITION=0

log 'Upgrade to version 2.2.0 completed successfully.'
log 'Verified CSV import panel and protected endpoint.'
log 'Verified redirect: /nodeapp -> 308 /nodeapp/'
log "Previous release retained at: $ROLLBACK"
log "Application backup: $APP_BACKUP"
log "Environment backup: $ENV_BACKUP"
log "Database backup: $DB_BACKUP"

#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SERVICE='silent-booth-booking'
APP_DIR='/var/www/anthonyapp'
ENV_FILE='/etc/silent-booth-booking.env'
BACKUP_DIR='/var/backups/silent-booth-booking'
EXPECTED_STAGE='/home/anthony/silent-booth-booking-nodeapp-2.5.1-stage'

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

verify_booking_window() {
  local config index_page

  if ! config="$(curl --fail --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    http://127.0.0.1:3000/nodeapp/api/config)"; then
    return 1
  fi

  if ! BOOKING_CONFIG="$config" /usr/bin/node <<'NODE'
'use strict';

const data = JSON.parse(process.env.BOOKING_CONFIG || '');
const window = data.bookingWindow;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addDays(value, days) {
  const parsed = new Date(`${value}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

if (!window || typeof window !== 'object') fail('bookingWindow is missing.');
if (window.timeZone !== 'Asia/Hong_Kong') fail('Unexpected school time zone.');
if (!isDate(window.schoolDate)) fail('Invalid schoolDate.');

const weekday = new Date(`${window.schoolDate}T00:00:00Z`).getUTCDay();
const weekStart = addDays(window.schoolDate, weekday === 0 ? -6 : 1 - weekday);
const weekEnd = addDays(weekStart, 5);
const nextWeekStart = addDays(weekStart, 7);
const nextWeekEnd = addDays(weekStart, 12);
const open = weekday >= 1 && weekday <= 6;

if (window.weekStart !== weekStart) fail('Incorrect current-week start.');
if (window.weekEnd !== weekEnd) fail('Incorrect current-week end.');
if (window.nextWeekStart !== nextWeekStart) fail('Incorrect next-week start.');
if (window.nextWeekEnd !== nextWeekEnd) fail('Incorrect next-week end.');
if (window.open !== open) fail('Incorrect booking-window open state.');
if (open) {
  if (window.bookableFrom !== window.schoolDate) fail('Incorrect first bookable date.');
  if (window.bookableThrough !== weekEnd) fail('Incorrect last bookable date.');
} else if (window.bookableFrom !== null || window.bookableThrough !== null) {
  fail('Sunday must not expose a bookable range.');
}
if (!Number.isInteger(window.refreshAfterSeconds) ||
    window.refreshAfterSeconds < 1 || window.refreshAfterSeconds > 86400) {
  fail('Invalid booking-window refresh interval.');
}
NODE
  then
    log 'The public configuration did not expose a valid Monday-to-Saturday window.'
    return 1
  fi

  if ! index_page="$(curl --fail --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    http://127.0.0.1:3000/nodeapp/)"; then
    return 1
  fi
  if ! grep -q 'id="bookingWindowStatus"' <<<"$index_page" || \
     ! grep -q 'id="bookingDateHelp"' <<<"$index_page"; then
    log 'The deployed booking page does not contain the current-week controls.'
    return 1
  fi
}

verify_timetable_feature() {
  local route status admin_page
  admin_page="$(curl --fail --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    http://127.0.0.1:3000/nodeapp/admin.html)"
  if ! grep -q 'id="timetablePreviewPanel"' <<<"$admin_page" || \
     ! grep -q 'id="applyTimetableButton"' <<<"$admin_page"; then
    log 'The deployed administrator page does not contain the timetable change controls.'
    return 1
  fi
  for route in timetable timetable/preview timetable/apply; do
    if [[ "$route" == timetable ]]; then
      status="$(curl --silent --show-error \
        --connect-timeout 2 --max-time 5 \
        --output /dev/null --write-out '%{http_code}' \
        "http://127.0.0.1:3000/nodeapp/api/admin/$route")"
    else
      status="$(curl --silent --show-error \
        --connect-timeout 2 --max-time 5 \
        --output /dev/null --write-out '%{http_code}' \
        --request POST --header 'Content-Type: application/json' \
        --data-binary '{}' \
        "http://127.0.0.1:3000/nodeapp/api/admin/$route")"
    fi
    if [[ "$status" != '401' ]]; then
      log "Protected timetable endpoint $route returned ${status:-missing}, expected 401."
      return 1
    fi
  done
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

verify_google_login_feature() {
  local config headers status location cookie

  config="$(curl --fail --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    http://127.0.0.1:3000/nodeapp/api/config)"
  if ! GOOGLE_CONFIG="$config" /usr/bin/node <<'NODE'
'use strict';
const data = JSON.parse(process.env.GOOGLE_CONFIG || '');
if (!data.googleLogin || data.googleLogin.enabled !== true ||
    data.googleLogin.domain !== 'keilong.edu.hk') {
  process.exit(1);
}
NODE
  then
    log 'The public configuration does not expose the required Google Workspace login.'
    return 1
  fi

  headers="$(curl --silent --show-error --connect-timeout 2 --max-time 5 \
    --output /dev/null --dump-header - \
    http://127.0.0.1:3000/nodeapp/api/auth/google/start)"
  headers="${headers//$'\r'/}"
  status="$(awk 'NR == 1 { print $2; exit }' <<<"$headers")"
  location="$(awk 'tolower($1) == "location:" { $1=""; sub(/^[[:space:]]+/, ""); print; exit }' <<<"$headers")"
  cookie="$(awk 'tolower($1) == "set-cookie:" { $1=""; sub(/^[[:space:]]+/, ""); print; exit }' <<<"$headers")"
  if [[ "$status" != '302' ]] ||
     ! GOOGLE_AUTHORIZATION_URL="$location" /usr/bin/node <<'NODE'
'use strict';
const url = new URL(process.env.GOOGLE_AUTHORIZATION_URL || '');
const valid = url.origin === 'https://accounts.google.com' &&
  url.pathname === '/o/oauth2/v2/auth' &&
  url.searchParams.get('hd') === 'keilong.edu.hk' &&
  url.searchParams.get('redirect_uri') ===
    'https://testing.keilong.edu.hk/nodeapp/api/auth/google/callback' &&
  url.searchParams.get('response_type') === 'code' &&
  url.searchParams.get('code_challenge_method') === 'S256' &&
  Boolean(url.searchParams.get('state')) &&
  Boolean(url.searchParams.get('nonce')) &&
  Boolean(url.searchParams.get('code_challenge'));
process.exit(valid ? 0 : 1);
NODE
  then
    log 'The Google authorization redirect is invalid.'
    return 1
  fi
  if [[ "$cookie" != *'Path=/nodeapp/api/auth/google/'* ]] ||
     [[ "$cookie" != *'HttpOnly'* ]] || [[ "$cookie" != *'SameSite=Lax'* ]] ||
     [[ "$cookie" != *'Secure'* ]]; then
    log 'The Google OAuth state cookie is missing required protections.'
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
      if [[ -e "$APP_DIR" || -L "$APP_DIR" ]]; then
        if [[ -z "$FAILED" || -e "$FAILED" || -L "$FAILED" ]] || \
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

# Prevent two authorized upgrade invocations from moving the same live tree.
exec 9>/run/silent-booth-booking-upgrade.lock
if ! flock --nonblock 9; then
  log 'STOP: another Silent Booth Booking upgrade is already running.'
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
  "$STAGE/booking-window.js" \
  "$STAGE/cookie.js" \
  "$STAGE/timetable.js" \
  "$STAGE/timetable-service.js" \
  "$STAGE/google-oauth.js" \
  "$STAGE/database/migrations/2.4.0-timetable.sql" \
  "$STAGE/deploy/configure-google-oauth-2.5.0.sh" \
  "$STAGE/package.json" \
  "$STAGE/package-lock.json" \
  "$STAGE/public/index.html" \
  "$STAGE/public/index.js" \
  "$STAGE/public/google-signin-light.svg" \
  "$STAGE/public/admin.html" \
  "$STAGE/public/admin.js" \
  "$STAGE/public/student-csv-import.js" \
  "$STAGE/student-import-jobs.js" \
  "$STAGE/scripts/check-booking-window.js" \
  "$STAGE/scripts/check-database.js" \
  "$STAGE/scripts/check-timetable.js" \
  "$STAGE/scripts/check-timetable-browser.js" \
  "$STAGE/scripts/check-student-csv-import.js" \
  "$STAGE/scripts/check-google-oauth.js" \
  "$STAGE/scripts/check-student-import-jobs.js" \
  "$STAGE/scripts/check-student-import-http.js" \
  "$STAGE/node_modules"; do
  if [[ ! -e "$required_path" ]]; then
    log "STOP: staged release is incomplete: $required_path"
    exit 1
  fi
done

if ! /usr/bin/node -e \
  "const p=require(process.argv[1]); process.exit(p.version === '2.5.1' ? 0 : 1)" \
  "$STAGE/package.json"; then
  log 'STOP: staged package version is not 2.5.1.'
  exit 1
fi

if [[ -L "$STAGE" ]] || \
   [[ -n "$(find "$STAGE" -path "$STAGE/node_modules" -prune -o -type l -print -quit)" ]]; then
  log 'STOP: an unexpected symbolic link is present in the staged application code.'
  exit 1
fi
if [[ -e "$STAGE/.env" ]] || \
   [[ -n "$(find "$STAGE" -path "$STAGE/node_modules" -prune -o -type f \
     \( -name '.env' -o -name 'data.json*' -o -name '*.pem' -o -name '*.key' \
        -o -name '*.p12' -o -name '*.pfx' \) -print -quit)" ]]; then
  log 'STOP: a secret or legacy data file is present in the staged application.'
  exit 1
fi

if [[ ! -d "$APP_DIR" || -L "$APP_DIR" ]]; then
  log "STOP: live application path is not the expected directory: $APP_DIR"
  exit 1
fi
if [[ ! -f "$APP_DIR/package.json" ]] || \
   ! /usr/bin/node -e \
     "const p=require(process.argv[1]); process.exit(p.version === '2.5.0' ? 0 : 1)" \
     "$APP_DIR/package.json"; then
  log 'STOP: the installed application is not the expected version 2.5.0.'
  exit 1
fi
if [[ ! -f "$ENV_FILE" || -L "$ENV_FILE" ]]; then
  log "STOP: protected environment is not the expected regular file: $ENV_FILE"
  exit 1
fi
if [[ "$(stat -c '%U:%G:%a' -- "$ENV_FILE")" != 'root:silentbooth:640' ]]; then
  log 'STOP: protected environment must be owned by root:silentbooth with mode 0640.'
  exit 1
fi
if [[ -L "$BACKUP_DIR" ]] || \
   [[ -e "$BACKUP_DIR" && ! -d "$BACKUP_DIR" ]]; then
  log "STOP: backup path is not the expected directory: $BACKUP_DIR"
  exit 1
fi
base_path_count="$(grep -c '^APP_BASE_PATH=' "$ENV_FILE" || true)"
if [[ "$base_path_count" != '1' ]] || \
   ! grep -qx 'APP_BASE_PATH=/nodeapp' "$ENV_FILE"; then
  log 'STOP: the protected environment must contain exactly one APP_BASE_PATH=/nodeapp line.'
  exit 1
fi
time_zone_count="$(grep -c '^SCHOOL_TIME_ZONE=' "$ENV_FILE" || true)"
if [[ "$time_zone_count" != '1' ]] || \
   ! grep -qx 'SCHOOL_TIME_ZONE=Asia/Hong_Kong' "$ENV_FILE"; then
  log 'STOP: the protected environment must contain exactly one SCHOOL_TIME_ZONE=Asia/Hong_Kong line.'
  exit 1
fi
if ! grep -qx 'DB_NAME=silent_booth_booking' "$ENV_FILE" || \
   [[ "$(grep -c '^DB_NAME=' "$ENV_FILE" || true)" != '1' ]]; then
  log 'STOP: protected DB_NAME must be exactly silent_booth_booking.'
  exit 1
fi
for google_name in PUBLIC_BASE_URL GOOGLE_OAUTH_CLIENT_ID \
  GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_OAUTH_STATE_SECRET \
  GOOGLE_OAUTH_ALLOWED_DOMAIN; do
  if [[ "$(grep -c "^${google_name}=" "$ENV_FILE" || true)" != '1' ]]; then
    log "STOP: protected environment must contain exactly one ${google_name} setting."
    exit 1
  fi
done
if ! grep -qx 'PUBLIC_BASE_URL=https://testing.keilong.edu.hk/nodeapp/' "$ENV_FILE" ||
   ! grep -qx 'GOOGLE_OAUTH_ALLOWED_DOMAIN=keilong.edu.hk' "$ENV_FILE"; then
  log 'STOP: Google public URL or allowed Workspace domain is incorrect.'
  exit 1
fi
runuser -u silentbooth -- /usr/bin/node --env-file="$ENV_FILE" -e \
  "const {readGoogleOAuthConfig}=require(process.argv[1]); const c=readGoogleOAuthConfig(process.env, '/nodeapp'); if(!c.enabled) process.exit(1)" \
  "$STAGE/google-oauth.js"
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  https://accounts.google.com/.well-known/openid-configuration >/dev/null
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  https://www.googleapis.com/oauth2/v3/certs >/dev/null
if systemctl is-active --quiet silent-booth-booking-preview; then
  log 'STOP: stop the private preview before upgrading so it cannot write during migration.'
  exit 1
fi
if [[ "$(systemctl show "$SERVICE" --property=User --value)" != 'silentbooth' ]]; then
  log 'STOP: unexpected production service account.'
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
APP_BACKUP="$BACKUP_DIR/app-before-role-import-2.5.1-${STAMP}.tar.gz"
ENV_BACKUP="$BACKUP_DIR/environment-before-role-import-2.5.1-${STAMP}.env"
DB_BACKUP="$BACKUP_DIR/database-before-role-import-2.5.1-${STAMP}.sql.gz"

for new_path in \
  "$RELEASE" "$ROLLBACK" "$FAILED" \
  "$APP_BACKUP" "$ENV_BACKUP" "$DB_BACKUP"; do
  if [[ -e "$new_path" || -L "$new_path" ]]; then
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
# Check the existing 2.5.0 application against its existing schema first.
runuser -u silentbooth -- /usr/bin/node \
  --env-file="$ENV_FILE" \
  "$APP_DIR/scripts/check-database.js"

SERVICE_TRANSITION=1
systemctl stop "$SERVICE"
if systemctl is-active --quiet "$SERVICE"; then
  log 'STOP: the production service is still active.'
  exit 1
fi

# Take the final database snapshot with the application stopped.
(
  umask 077
  mariadb-dump --single-transaction --routines --triggers --events \
    silent_booth_booking | gzip -9 > "$DB_BACKUP"
)
test -s "$DB_BACKUP"
gzip -t "$DB_BACKUP"
chmod 0600 "$DB_BACKUP"
chown root:root "$DB_BACKUP"


# This release makes no database schema changes.
runuser -u silentbooth -- /usr/bin/node \
  --env-file="$ENV_FILE" \
  "$RELEASE/scripts/check-database.js"

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
if ! verify_booking_window; then
  log 'New release failed the current-school-week feature check.'
  exit 1
fi
if ! verify_import_feature; then
  log 'New release failed the CSV import feature check.'
  exit 1
fi

if ! verify_timetable_feature; then
  log 'New release failed the protected timetable endpoint checks.'
  exit 1
fi
if ! verify_google_login_feature; then
  log 'New release failed the Google Workspace login configuration checks.'
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

log 'Upgrade to version 2.5.1 completed successfully.'
log 'Verified the Monday-to-Saturday booking window and Sunday closure.'
log 'Verified CSV import panel and protected endpoint.'
log 'Verified mixed student/teacher CSV roles and no fixed account-count limit.'
log 'Verified protected timetable endpoints and the required 11-table database schema.'
log 'Verified Google Workspace authorization redirect, domain restriction, PKCE and protected state cookie.'
log 'The protected environment and Nginx configuration were not changed.'
log 'Google sign-in is limited to active, pre-registered @keilong.edu.hk accounts.'
log 'Verified redirect: /nodeapp -> 308 /nodeapp/'
log "Previous release retained at: $ROLLBACK"
log "Application backup: $APP_BACKUP"
log "Environment backup: $ENV_BACKUP"
log "Database backup: $DB_BACKUP"

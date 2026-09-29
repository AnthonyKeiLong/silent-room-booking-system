#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

ENV_FILE='/etc/silent-booth-booking.env'
BACKUP_DIR='/var/backups/silent-booth-booking'
EXPECTED_STAGE='/home/anthony/silent-booth-booking-nodeapp-2.5.0-stage'
PUBLIC_BASE_URL='https://testing.keilong.edu.hk/nodeapp/'
ALLOWED_DOMAIN='keilong.edu.hk'

if [[ "$EUID" -ne 0 ]]; then
  echo 'Run this script with sudo.'
  exit 1
fi
if [[ ! -f "$ENV_FILE" || -L "$ENV_FILE" ]]; then
  echo "STOP: protected environment is not a regular file: $ENV_FILE"
  exit 1
fi
if [[ "$(stat -c '%U:%G:%a' -- "$ENV_FILE")" != 'root:silentbooth:640' ]]; then
  echo 'STOP: protected environment must be root:silentbooth with mode 0640.'
  exit 1
fi
if [[ ! -f "$EXPECTED_STAGE/google-oauth.js" ]]; then
  echo 'STOP: verified version 2.5.0 stage is missing.'
  exit 1
fi

read -r -p 'Google OAuth web client ID: ' CLIENT_ID
read -r -s -p 'Google OAuth web client secret (hidden): ' CLIENT_SECRET
printf '\n'

if [[ ! "$CLIENT_ID" =~ ^[A-Za-z0-9._-]{10,255}\.apps\.googleusercontent\.com$ ]]; then
  echo 'STOP: client ID format is invalid.'
  exit 1
fi
if [[ ! "$CLIENT_SECRET" =~ ^[A-Za-z0-9_-]{16,512}$ ]]; then
  echo 'STOP: client secret format is invalid.'
  exit 1
fi

STATE_SECRET="$(openssl rand -hex 32)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 -o root -g root "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/environment-before-google-configuration-${STAMP}.env"
TEMP_FILE="$(mktemp /etc/silent-booth-booking.env.tmp.XXXXXX)"
cleanup() {
  rm -f -- "$TEMP_FILE"
  unset CLIENT_SECRET STATE_SECRET
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

cp -a -- "$ENV_FILE" "$BACKUP"
chmod 0600 "$BACKUP"
chown root:root "$BACKUP"

awk '
  !/^(PUBLIC_BASE_URL|GOOGLE_OAUTH_CLIENT_ID|GOOGLE_OAUTH_CLIENT_SECRET|GOOGLE_OAUTH_STATE_SECRET|GOOGLE_OAUTH_ALLOWED_DOMAIN)=/
' "$ENV_FILE" > "$TEMP_FILE"
printf '\nPUBLIC_BASE_URL=%s\n' "$PUBLIC_BASE_URL" >> "$TEMP_FILE"
printf 'GOOGLE_OAUTH_CLIENT_ID=%s\n' "$CLIENT_ID" >> "$TEMP_FILE"
printf 'GOOGLE_OAUTH_CLIENT_SECRET=%s\n' "$CLIENT_SECRET" >> "$TEMP_FILE"
printf 'GOOGLE_OAUTH_STATE_SECRET=%s\n' "$STATE_SECRET" >> "$TEMP_FILE"
printf 'GOOGLE_OAUTH_ALLOWED_DOMAIN=%s\n' "$ALLOWED_DOMAIN" >> "$TEMP_FILE"
chown root:silentbooth "$TEMP_FILE"
chmod 0640 "$TEMP_FILE"

runuser -u silentbooth -- /usr/bin/node --env-file="$TEMP_FILE" -e \
  "const {readGoogleOAuthConfig}=require(process.argv[1]); const c=readGoogleOAuthConfig(process.env, '/nodeapp'); if(!c.enabled) process.exit(1)" \
  "$EXPECTED_STAGE/google-oauth.js"

mv -- "$TEMP_FILE" "$ENV_FILE"
trap - EXIT HUP INT TERM
unset CLIENT_SECRET STATE_SECRET

echo 'Google OAuth configuration installed without displaying either secret.'
echo 'The running version 2.4.0 application ignores these settings until version 2.5.0 is installed.'
echo "Protected environment backup: $BACKUP"

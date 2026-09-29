# Silent Booth Booking 2.5.0: Google Workspace sign-in

This upgrades the verified production version 2.4.0 to 2.5.0. It keeps the
existing email/password login and adds server-side Google OpenID Connect login
for active, pre-registered `@keilong.edu.hk` users.

## Access policy

- Google does not decide whether somebody is a student or teacher. The existing
  booking-system account supplies the role, display name, class and active state.
- A Google login succeeds only when its verified Workspace email exactly matches
  an active account already stored in the booking database.
- The signed Google `hd` claim must be exactly `keilong.edu.hk`; the email suffix
  and verified-email claim are also checked.
- First successful login links Google's permanent `sub` identifier to the user.
  Later logins must match both the email and linked identifier.
- No Google access or refresh token is stored. The app requests only `openid` and
  `email`, and creates its normal server-side booking session after verification.
- Existing password hashes and password login remain unchanged.

## IT prerequisite

In a school-owned Google Cloud project, IT must configure an OAuth consent screen
for internal school use and create an **OAuth 2.0 Web application** client.

Authorized redirect URI (exact, including HTTPS and path):

```text
https://testing.keilong.edu.hk/nodeapp/api/auth/google/callback
```

The server must have outbound HTTPS/DNS access to:

```text
accounts.google.com
oauth2.googleapis.com
www.googleapis.com
```

IT should deliver the client ID and client secret through an approved private
channel. Do not send the client secret in chat, email screenshots, or command-line
arguments.

## Phase 1: stage and test the release

Upload these files to `/home/anthony/`:

```text
silent-booth-booking-nodeapp-2.5.0.tar.gz
silent-booth-booking-nodeapp-2.5.0.tar.gz.sha256
```

Then run this safe staging block. It does not change the live application or
database:

```bash
(
set -euo pipefail
cd /home/anthony
ARCHIVE='/home/anthony/silent-booth-booking-nodeapp-2.5.0.tar.gz'
CHECKSUM='/home/anthony/silent-booth-booking-nodeapp-2.5.0.tar.gz.sha256'
STAGE='/home/anthony/silent-booth-booking-nodeapp-2.5.0-stage'

test -f "$ARCHIVE"
test -f "$CHECKSUM"
sha256sum --check "$CHECKSUM"
tar -tzf "$ARCHIVE" >/dev/null
if tar -tzf "$ARCHIVE" | grep -E '(^/)|(^|/)\.\.(/|$)' >/dev/null; then
  echo 'STOP: the archive contains an unsafe path.'
  exit 1
fi
if tar -tvzf "$ARCHIVE" |
  awk '$1 !~ /^[-d]/ { found=1 } END { exit(found ? 0 : 1) }'; then
  echo 'STOP: the archive contains an unexpected link or special file.'
  exit 1
fi
if [ -e "$STAGE" ] || [ -L "$STAGE" ]; then
  echo "STOP: staging path already exists: $STAGE"
  exit 1
fi

mkdir -m 0700 "$STAGE"
tar --extract --gzip --file "$ARCHIVE" --directory "$STAGE" \
  --no-same-owner --no-same-permissions
chmod 0700 "$STAGE"
cd "$STAGE"

test -f google-oauth.js
test -f database/migrations/2.5.0-google-oauth.sql
test -f deploy/configure-google-oauth-2.5.0.sh
test -f deploy/upgrade-google-oauth-2.5.0.sh
test -f scripts/check-google-oauth.js
test -f public/google-signin-light.svg
test ! -e .env
test "$(node -p "require('./package.json').version")" = '2.5.0'
if find . -type f \
  \( -name '.env' -o -name 'data.json*' -o -name '*.pem' -o \
     -name '*.key' -o -name '*.p12' -o -name '*.pfx' \) \
  -print -quit | grep -q .; then
  echo 'STOP: an unexpected secret or legacy data file is present.'
  exit 1
fi

npm ci --omit=dev
npm run check
bash -n deploy/configure-google-oauth-2.5.0.sh
bash -n deploy/upgrade-google-oauth-2.5.0.sh
echo 'PHASE 1 PASSED'
)
```

## Phase 2: install protected OAuth configuration

Only after Phase 1 passes and IT supplies the credentials:

```bash
sudo bash \
  /home/anthony/silent-booth-booking-nodeapp-2.5.0-stage/deploy/configure-google-oauth-2.5.0.sh
```

The script prompts for the client ID and then for the client secret with hidden
input. It generates the separate state-cookie signing secret locally, creates a
root-only environment backup, validates the new protected environment without
displaying credentials, and atomically installs it. Version 2.4.0 ignores the new
settings, so the production site continues to work until Phase 3.

## Phase 3: backed-up upgrade

Arrange a short maintenance window, stop any private preview, and do not edit
accounts, bookings or timetables during the upgrade.

```bash
(
set -euo pipefail
STAGE='/home/anthony/silent-booth-booking-nodeapp-2.5.0-stage'
RUNNER='/run/silent-booth-upgrade-google-oauth-2.5.0.sh'
UNIT="silent-booth-google-oauth-upgrade-$(date -u +%Y%m%dT%H%M%SZ)"

sudo install -m 0700 -o root -g root \
  "$STAGE/deploy/upgrade-google-oauth-2.5.0.sh" "$RUNNER"

if sudo systemd-run --unit="$UNIT" --property=Type=exec --wait \
  /bin/bash "$RUNNER" "$STAGE"; then
  RUN_STATUS=0
else
  RUN_STATUS=$?
fi

sudo journalctl -u "$UNIT" -n 300 --no-pager || true
echo "upgrade unit: $UNIT"
echo "upgrade exit status: $RUN_STATUS"
exit "$RUN_STATUS"
)
```

The upgrader verifies the exact 2.4.0 starting version and protected environment,
checks outbound Google metadata/certificate access, creates fresh application,
environment and database backups, stops the service, adds only the nullable
`users.google_subject` column and unique index, switches the full code release,
and validates all existing and Google-login routes. It never changes Nginx or
runs the full schema.

## Phase 4: acceptance test

1. Hard-refresh `https://testing.keilong.edu.hk/nodeapp/`.
2. Confirm the Google login button is visible and password login still appears.
3. Use an active, pre-registered `@keilong.edu.hk` test account.
4. Confirm a consumer Gmail account and an unregistered school account are denied.
5. Confirm the authorized user keeps the role already assigned in the admin panel.
6. Log out, use Google login again, and confirm the linked account works.
7. Confirm password login, booking, CSV import and timetable management still work.

Do not delete the retained backups or previous release until these checks pass.

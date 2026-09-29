# Silent Booth Booking 2.1.0: current-server upgrade

This is the authoritative upgrade guide for the server state verified on
25 August 2026. It updates the existing application without changing,
testing, or reloading the school-managed Nginx configuration.

## Fixed routing contract

- Public path: `/nodeapp/`
- Node listener: `127.0.0.1:3000`
- Nginx forwards the `/nodeapp` prefix unchanged to Node.
- The protected environment file must contain `APP_BASE_PATH=/nodeapp`.
- Do not install or use `deploy/nginx-site.conf`; it is a reference note only.
- Do not enter a real password until IT confirms that the public address uses
  valid HTTPS. If TLS terminates on another school gateway, IT must confirm
  that the browser still sees an `https://` address and that Node receives the
  original scheme as HTTPS.

The exact public address, after HTTPS is confirmed, is:

```text
https://testing.keilong.edu.hk/nodeapp/
```

## Confirmed state before this upgrade

- MariaDB and all seven application tables exist.
- A protected database backup has already passed a separate restore test.
- `silent-booth-booking.service` is active and enabled.
- Node and MariaDB listen only on `127.0.0.1`.
- `/etc/silent-booth-booking.env` is owned by `root:silentbooth` with mode
  `0640`.
- The active administrator is `teacher@keilong.edu.hk`.
- The old `admin@keilong.edu.hk` account is disabled. Do not delete it until
  the new administrator has logged in successfully through the public site.

## What version 2.1.0 changes

- Browser assets, API calls, and navigation stay below `/nodeapp/`.
- Exact `/nodeapp` requests redirect to `/nodeapp/`.
- The session cookie is limited to `/nodeapp/`.
- Direct loopback health checks at `/api/health` remain available.
- Requests such as `/nodeapplication/...` are not treated as application
  requests.
- Malformed session cookies are rejected safely instead of producing a server
  error.

The release contains no `.env`, database password, user data, backup, private
key, or `node_modules` directory.

## Phase 1: upload, inspect, and test the release

Upload both files to `/home/anthony/` using SFTP/WinSCP:

```text
silent-booth-booking-nodeapp-2.1.0.tar.gz
silent-booth-booking-nodeapp-2.1.0.tar.gz.sha256
```

Paste this block in PuTTY. It verifies the transfer, rejects unsafe archive
paths and links, extracts without trusting archive permissions, installs the
locked production dependencies, and runs the code checks. It deliberately
stops instead of overwriting an earlier staging directory.

```bash
(
set -euo pipefail
cd /home/anthony

ARCHIVE="$HOME/silent-booth-booking-nodeapp-2.1.0.tar.gz"
CHECKSUM="$HOME/silent-booth-booking-nodeapp-2.1.0.tar.gz.sha256"
STAGE="$HOME/silent-booth-booking-nodeapp-2.1.0-stage"

sha256sum --check "$CHECKSUM"
tar -tzf "$ARCHIVE" >/dev/null

if tar -tzf "$ARCHIVE" | \
  grep -E '(^/)|(^|/)\.\.(/|$)' >/dev/null; then
  echo 'STOP: the archive contains an unsafe path.'
  exit 1
fi

if tar -tvzf "$ARCHIVE" | \
  awk '$1 ~ /^[lh]/ { found=1 } END { exit(found ? 0 : 1) }'; then
  echo 'STOP: the archive contains an unexpected link.'
  exit 1
fi

if [ -e "$STAGE" ]; then
  echo "STOP: staging path already exists: $STAGE"
  exit 1
fi

mkdir -m 0700 "$STAGE"
tar --extract --gzip --file "$ARCHIVE" \
  --directory "$STAGE" \
  --no-same-owner --no-same-permissions
chmod 0700 "$STAGE"
cd "$STAGE"

test -f server.js
test -f app-base-path.js
test -f cookie.js
test -f deploy/upgrade-nodeapp.sh
test -f scripts/check-base-path.js
test -f scripts/check-cookie.js
test ! -e .env

if find . -type f \
  \( -name '.env' -o -name 'data.json*' -o \
     -name '*.pem' -o -name '*.key' -o \
     -name '*.p12' -o -name '*.pfx' \) \
  -print -quit | grep -q .; then
  echo 'STOP: an unexpected secret or data file is present.'
  exit 1
fi

npm ci --omit=dev
npm run check
bash -n deploy/upgrade-nodeapp.sh
echo 'Upgrade script Bash syntax passed.'
)
```

The first line must end with `OK`. Expected final check messages include:

```text
browser security checks passed
Base-path normalization and request rewriting checks passed.
Cookie parsing checks passed.
public/styles.css: present
Upgrade script Bash syntax passed.
```

## Phase 2: protected upgrade and automatic rollback

Do not start this phase until Phase 1 succeeds. The included reviewed script:

- backs up the current application and protected environment;
- creates and validates a fresh MariaDB backup;
- prepares read-only service permissions for the new release;
- adds exactly one `APP_BASE_PATH=/nodeapp` setting;
- briefly stops the Node service and switches directories;
- uses bounded direct and `/nodeapp` health checks;
- requires the exact `308` redirect to `/nodeapp/`; and
- automatically restores and health-checks the previous release if anything
  fails during the switch.

It runs as a transient systemd service. A PuTTY disconnect therefore does not
interrupt the server-side switch. It contains no Nginx command.

Paste this block in PuTTY:

```bash
(
set -euo pipefail
STAGE='/home/anthony/silent-booth-booking-nodeapp-2.1.0-stage'
RUNNER='/run/silent-booth-upgrade-nodeapp-2.1.0.sh'
UNIT="silent-booth-nodeapp-upgrade-$(date -u +%Y%m%dT%H%M%SZ)"

sudo install -m 0700 -o root -g root \
  "$STAGE/deploy/upgrade-nodeapp.sh" "$RUNNER"

if sudo systemd-run \
  --unit="$UNIT" \
  --property=Type=exec \
  --wait \
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

A successful journal ends with all of the following:

```text
Upgrade completed successfully.
active
Verified redirect: /nodeapp -> 308 /nodeapp/
Previous release retained at: ...
Application backup: ...
Environment backup: ...
Database backup: ...
```

If PuTTY disconnects, reconnect and show the recent upgrade journal with:

```bash
sudo journalctl \
  -u 'silent-booth-nodeapp-upgrade-*' \
  --since '2 hours ago' \
  --no-pager
```

Do not rerun Phase 2 after a failure until the complete journal has been
reviewed.

## Phase 3: local verification

After Phase 2 reports success, run:

```bash
sudo systemctl is-active silent-booth-booking
sudo systemctl is-enabled silent-booth-booking
sudo ss -ltnp | grep -E ':(3000|3306)[[:space:]]'

curl --fail --silent --show-error \
  --connect-timeout 2 --max-time 5 \
  http://127.0.0.1:3000/api/health
echo

curl --fail --silent --show-error \
  --connect-timeout 2 --max-time 5 \
  http://127.0.0.1:3000/nodeapp/api/health
echo
```

Expected: the service is `active` and `enabled`, both listeners remain on
`127.0.0.1`, and both health requests return:

```json
{"status":"ok","database":"connected"}
```

## Phase 4: public acceptance test

Do this only after IT confirms valid HTTPS and correct forwarding of the
original HTTPS scheme. Open:

```text
https://testing.keilong.edu.hk/nodeapp/
```

Verify:

1. The browser shows a valid HTTPS connection.
2. The styled login page appears; it must not look like unformatted HTML.
3. Log in as `teacher@keilong.edu.hk` using the password already known to the
   administrator. Do not send or paste that password anywhere else.
4. The booking interface loads and the management link opens
   `/nodeapp/admin.html`.
5. Log out and log in again.

Do not delete the disabled old administrator until all five checks pass.

## Rollback boundary

Deployment-time failures are handled automatically by the upgrade script. The
retained version 2.0.0 application is an internal recovery baseline only: it
does not understand the fixed public `/nodeapp` prefix. Therefore, do not
perform a later manual directory rollback or change Nginx. Retain the printed
backup and rollback paths, collect the service journal, and review the failure
before another action.

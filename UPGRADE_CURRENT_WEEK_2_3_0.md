# Silent Booth Booking 2.3.0: current-school-week booking upgrade

> Historical, undeployed release: do not use this procedure for the current
> server. Upgrade production 2.2.0 directly to 2.4.0 using
> [UPGRADE_TIMETABLE_2_4_0.md](UPGRADE_TIMETABLE_2_4_0.md), which includes both
> the weekly booking rule and editable timetables.

This guide upgrades the verified version 2.2.0 application to version 2.3.0.
It changes the student booking window to the current Hong Kong school week:

- Monday through Saturday: students may book from the current date through
  that Saturday.
- Sunday: new bookings are closed.
- Monday at 00:00 in `Asia/Hong_Kong`: the new Monday-to-Saturday window opens.
- The server enforces the rule. Changing a browser clock or sending an API
  request directly cannot extend the window.

The upgrade preserves existing users, bookings, cancellations, modes, and
calendar settings. It does not change the MariaDB schema or the school-managed
Nginx configuration. It also retains the administrator CSV import function.

## Phase 1: upload, inspect, install, and test the staged release

Upload these two files to `/home/anthony/` with WinSCP or SFTP:

```text
silent-booth-booking-nodeapp-2.3.0.tar.gz
silent-booth-booking-nodeapp-2.3.0.tar.gz.sha256
```

Then paste this complete block into PuTTY:

```bash
(
set -euo pipefail
cd /home/anthony

ARCHIVE="$HOME/silent-booth-booking-nodeapp-2.3.0.tar.gz"
CHECKSUM="$HOME/silent-booth-booking-nodeapp-2.3.0.tar.gz.sha256"
STAGE="$HOME/silent-booth-booking-nodeapp-2.3.0-stage"

test -f "$ARCHIVE"
test -f "$CHECKSUM"
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
test -f booking-window.js
test -f public/index.html
test -f public/index.js
test -f public/admin.html
test -f public/admin.js
test -f public/student-csv-import.js
test -f scripts/check-booking-window.js
test -f scripts/check-student-csv-import.js
test -f deploy/upgrade-current-week-2.3.0.sh
test ! -e .env
test "$(node -p "require('./package.json').version")" = '2.3.0'

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
bash -n deploy/upgrade-current-week-2.3.0.sh
echo 'PHASE 1 PASSED'
)
```

The checksum line must end with `OK`, the booking-window test must report that
it passed, and the final line must be:

```text
PHASE 1 PASSED
```

Stop and send the complete output for review if any command reports an error.

## Phase 2: protected upgrade with automatic rollback

Phase 2 creates fresh application, environment, and database backups before
briefly restarting the Node service. The Nginx configuration is not touched.
If a switch-time check fails, the script restores version 2.2.0 automatically.

Run Phase 2 only after Phase 1 passes:

```bash
(
set -euo pipefail
STAGE='/home/anthony/silent-booth-booking-nodeapp-2.3.0-stage'
RUNNER='/run/silent-booth-upgrade-current-week-2.3.0.sh'
UNIT="silent-booth-week-upgrade-$(date -u +%Y%m%dT%H%M%SZ)"

sudo install -m 0700 -o root -g root \
  "$STAGE/deploy/upgrade-current-week-2.3.0.sh" "$RUNNER"

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

A successful journal includes all of these messages:

```text
Upgrade to version 2.3.0 completed successfully.
Verified the Monday-to-Saturday booking window and Sunday closure.
Verified CSV import panel and protected endpoint.
Verified redirect: /nodeapp -> 308 /nodeapp/
Previous release retained at: ...
Application backup: ...
Environment backup: ...
Database backup: ...
upgrade exit status: 0
```

If PuTTY disconnects, reconnect and run:

```bash
sudo journalctl \
  -u 'silent-booth-week-upgrade-*' \
  --since '2 hours ago' \
  --no-pager
```

Do not rerun Phase 2 after a failure until the complete journal has been
reviewed.

## Phase 3: verify the installed service

After Phase 2 succeeds, run:

```bash
cd /var/www/anthonyapp

node -p "'installed version: ' + require('./package.json').version"
sudo systemctl is-active silent-booth-booking
sudo systemctl is-enabled silent-booth-booking

curl --fail --silent --show-error \
  --connect-timeout 2 --max-time 5 \
  http://127.0.0.1:3000/nodeapp/api/health
echo

curl --fail --silent --show-error \
  --connect-timeout 2 --max-time 5 \
  http://127.0.0.1:3000/nodeapp/api/config
echo
```

Expected output includes:

```text
installed version: 2.3.0
active
enabled
{"status":"ok","database":"connected"}
```

The configuration response must include a `bookingWindow` object. On Monday
through Saturday, `bookableFrom` is the school date and `bookableThrough` is
that Saturday. On Sunday, `open` is `false` and both bookable bounds are
`null`.

## Phase 4: browser acceptance test

Use the official site with valid HTTPS:

```text
https://testing.keilong.edu.hk/nodeapp/
```

1. Perform a hard refresh, then log in with a test student account.
2. Confirm the date field cannot select a past date or a date after the current
   Saturday.
3. Select an available day in the permitted range and confirm that its slots
   load normally.
4. Make one test booking, confirm that it appears under the student's bookings,
   then cancel it.
5. Confirm that manually entering a date outside the permitted range is
   rejected and does not create a booking.
6. Log in as the administrator and confirm that the administrator panel and CSV
   student import panel still open normally.
7. Confirm the browser shows the official hostname and a valid HTTPS
   connection before using real credentials or importing real student data.

If this test is performed on Sunday, the page must say that booking is closed
and identify the next Monday. Repeat the booking-and-cancellation portion on
Monday through Saturday.

Existing future bookings are retained and remain visible/cancellable; the new
window controls creation of new bookings only.

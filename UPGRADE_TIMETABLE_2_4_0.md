# Silent Booth Booking 2.4.0: weekly bookings and editable timetables

This is the upgrade from the verified production version **2.2.0** directly to
**2.4.0**. Version 2.3.0 was prepared locally but was not deployed; do not install
it first. Use this guide instead of the historical initial-install instructions.

## What changes

- New bookings are limited to the current Hong Kong Monday-to-Saturday week.
  Past days are unavailable, Sunday is closed, and the next window opens at
  Monday 00:00 in `Asia/Hong_Kong`.
- Teachers can edit mode time slots and assign special timetables to dates in
  the administrator page. Changes are stored in the server database.
- Each change must be previewed. The preview lists bookings that would become
  invalid, and the teacher must explicitly confirm before applying it.
- Affected, not-yet-started bookings are cancelled for an administrative
  timetable reason. These records are separate from student cancellations and
  never count toward cancellation penalties.
- Signed-in students see the revised timetable without a manual page reload:
  active pages refresh approximately every 15 seconds and when returning to
  the page. The server checks the latest timetable when accepting a booking.
- Students see recent timetable-cancellation reasons on the booking page.
  **Email notifications are deferred: this release does not send email.**
- Student CSV import and existing accounts remain available.

There is no Nginx change, password reset, database replacement, or environment
file replacement. Existing bookings are not cancelled merely by installing the
new weekly rule. Only a later, explicitly confirmed timetable change cancels
affected bookings.

The database migration adds four tables, for 11 required application tables:
`timetable_state`, `timetable_change_previews`, `timetable_changes`, and
`administrative_cancellations`. Existing data and customized mode slots are
preserved. **Never rerun `database/schema.sql` on the live database**: the full
fresh-install schema includes default-mode initialization. The upgrade runs only
`database/migrations/2.4.0-timetable.sql`.

## Phase 1: upload and check the staged release

Upload these two files to `/home/anthony/` using SFTP or WinSCP:

```text
silent-booth-booking-nodeapp-2.4.0.tar.gz
silent-booth-booking-nodeapp-2.4.0.tar.gz.sha256
```

Do not delete old application files or backups. Do not upload `.env`, database
dumps, real student CSV files, or Windows `node_modules` into the application.

Paste this complete block into PuTTY:

```bash
(
set -euo pipefail
cd /home/anthony
ARCHIVE='/home/anthony/silent-booth-booking-nodeapp-2.4.0.tar.gz'
CHECKSUM='/home/anthony/silent-booth-booking-nodeapp-2.4.0.tar.gz.sha256'
STAGE='/home/anthony/silent-booth-booking-nodeapp-2.4.0-stage'

test -f "$ARCHIVE"
test -f "$CHECKSUM"
sha256sum --check "$CHECKSUM"
tar -tzf "$ARCHIVE" >/dev/null

if tar -tzf "$ARCHIVE" |
  grep -E '(^/)|(^|/)\.\.(/|$)' >/dev/null; then
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
tar --extract --gzip --file "$ARCHIVE" \
  --directory "$STAGE" --no-same-owner --no-same-permissions
chmod 0700 "$STAGE"
cd "$STAGE"

test -f server.js
test -f booking-window.js
test -f timetable.js
test -f timetable-service.js
test -f database/migrations/2.4.0-timetable.sql
test -f public/student-csv-import.js
test -f scripts/check-booking-window.js
test -f scripts/check-timetable.js
test -f scripts/check-timetable-browser.js
test -f deploy/upgrade-timetable-2.4.0.sh
test ! -e .env
test "$(node -p "require('./package.json').version")" = '2.4.0'

if find . -type f \
  \( -name '.env' -o -name 'data.json*' -o -name '*.pem' -o \
     -name '*.key' -o -name '*.p12' -o -name '*.pfx' \) \
  -print -quit | grep -q .; then
  echo 'STOP: an unexpected secret or legacy data file is present.'
  exit 1
fi

npm ci --omit=dev
npm run check
bash -n deploy/upgrade-timetable-2.4.0.sh
echo 'PHASE 1 PASSED'
)
```

The checksum must report `OK`, and the final line must be `PHASE 1 PASSED`.
If anything fails, stop and share the error, not passwords or student data.
This phase does not change the live application or database.

## Phase 2: backed-up upgrade

Arrange a short maintenance window and ensure the temporary private preview is
stopped. Do not edit timetables or import accounts while the upgrade is running.

The script verifies that the installed version is 2.2.0, backs up the application
and protected environment, then stops the service. It backs up the database with
the application stopped, applies the exact additive migration, checks the new
schema, switches the code, and restarts the service. SMTP setup is not needed.
The script neither changes Nginx nor writes to `/etc/silent-booth-booking.env`.

Run only after Phase 1 passes:

```bash
(
set -euo pipefail
STAGE='/home/anthony/silent-booth-booking-nodeapp-2.4.0-stage'
RUNNER='/run/silent-booth-upgrade-timetable-2.4.0.sh'
UNIT="silent-booth-timetable-upgrade-$(date -u +%Y%m%dT%H%M%SZ)"

sudo install -m 0700 -o root -g root \
  "$STAGE/deploy/upgrade-timetable-2.4.0.sh" "$RUNNER"

if sudo systemd-run \
  --unit="$UNIT" --property=Type=exec --wait \
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

Success includes:

```text
Version 2.4.0 schema OK; timetable state and no-penalty cancellation records are available.
Upgrade to version 2.4.0 completed successfully.
Verified protected timetable endpoints and the required 11-table database schema.
This release provides in-app cancellation notices; it does not send email.
Previous release retained at: ...
Application backup: ...
Environment backup: ...
Database backup: ...
upgrade exit status: 0
```

The journal records exact root-only backup filenames under
`/var/backups/silent-booth-booking/` and the previous code under
`/var/www/anthonyapp-rollback-TIMESTAMP`. Keep them.

If PuTTY disconnects, reconnect and read the result; do not run the upgrade twice:

```bash
sudo journalctl -u 'silent-booth-timetable-upgrade-*' \
  --since '2 hours ago' --no-pager
```

If a migration or switch-time check fails, the script attempts to restart the
previous application. It does not restore a database dump over production and
does not drop any added tables. If the migration partially completed, review
the journal before deciding how to retry. Restoring old code does not undo
already-confirmed cancellations or recreate bookings. Version 2.2.0 ignores the
new administrative-cancellation records, so they do not become penalties; it
also does not display the new student notices. Do not run either old upgrade
script or a manual database restore as a rollback shortcut.

## Phase 3: check the installed service

```bash
cd /var/www/anthonyapp
node -p "'installed version: ' + require('./package.json').version"
sudo systemctl is-active silent-booth-booking
sudo systemctl is-enabled silent-booth-booking
sudo -u silentbooth /usr/bin/node \
  --env-file=/etc/silent-booth-booking.env \
  /var/www/anthonyapp/scripts/check-database.js
curl --fail --silent --show-error \
  --connect-timeout 2 --max-time 5 \
  http://127.0.0.1:3000/nodeapp/api/health
echo
curl --fail --silent --show-error \
  --connect-timeout 2 --max-time 5 \
  http://127.0.0.1:3000/nodeapp/api/config
echo
sudo ss -ltnp | grep -E ':(3000|3306)[[:space:]]'
```

Expected: version `2.4.0`, service `active` and `enabled`, all 11 required tables
available, health `{"status":"ok","database":"connected"}`, and both listeners
on `127.0.0.1`. The public configuration includes the current `bookingWindow`.

## Phase 4: website acceptance test

Use the existing valid-HTTPS site:
[https://testing.keilong.edu.hk/nodeapp/](https://testing.keilong.edu.hk/nodeapp/).
Use a dedicated test student and a date/time with no real bookings. Keep a copy
of the original timetable settings; changing back does not restore a cancelled
booking automatically.

1. Hard-refresh both the student and administrator pages after the upgrade.
2. Confirm that the student can select only today through the current Saturday.
   On Sunday, new booking is closed until Monday; test booking creation on an
   open day instead.
3. Sign in as a teacher and open 「時間表與特殊日期管理」. Confirm existing mode
   slots and special dates have been preserved.
4. Change a test date or slot, choose the preview action, and verify the affected
   booking list. Return to editing without applying once; nothing should change.
5. Create one future test booking, then preview a timetable change that removes
   that exact slot. Confirm the preview identifies only the intended test
   booking. If a real student's booking appears, do not apply the test change.
6. Explicitly confirm and choose 「確認套用至資料庫」. Keep the student tab open:
   within approximately 15 seconds, it should show the updated slots and the
   administrative cancellation reason without a manual reload.
7. Confirm the cancelled booking is absent from active bookings and does not
   increase the student's cancellation penalty count. No email should be sent.
8. Confirm a stale booking confirmation cannot reserve a removed or changed slot.
   It should request an updated timetable rather than silently changing the time.
9. Restore the original timetable through the same preview-and-confirm process.
   The test cancellation remains as an audit record; create a new booking if
   needed rather than expecting automatic restoration.
10. Check login/logout, the administrator panel, and the existing CSV import
    panel. Do not import real students merely as a deployment smoke test.

The weekly window and timetable are separate rules: configuring a special date
in a later week does not let students book that date before its Monday arrives.

## Daily use

Teachers edit time slots or special dates, preview the effect, then confirm.
Students use the same website and login. No PuTTY command, Nginx reload, or
manual database edit is required for routine timetable changes.

A changed preview must be regenerated if another teacher changes the timetable
or bookings change before confirmation. This prevents a confirmation from
cancelling a different set of bookings from the set the teacher reviewed.

Email notification remains a separate future feature. Until it is implemented,
use the school's normal communication channel for urgent timetable changes;
the website notice is visible when the student next uses the booking page.

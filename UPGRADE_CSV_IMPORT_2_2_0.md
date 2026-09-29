# Silent Booth Booking 2.2.0: CSV student import upgrade

This guide upgrades the verified version 2.1.0 application to version 2.2.0.
It adds a teacher-only CSV import function to the administrator panel.

This upgrade does not change the school-managed Nginx configuration and does
not change the MariaDB schema.

## What the import does

- Required CSV columns: `email,password,display_name`
- Optional CSV column: `class_name`; the default is `Student`
- The server always creates every imported account as an active `student`
- A CSV file cannot choose `teacher`, `role`, or `active`
- Passwords are stored only as bcrypt hashes, never as plaintext
- The CSV file itself is not saved on the server
- Existing accounts are never changed or deleted
- If any row is invalid or any email already exists, no account in that batch
  is created
- Each import is limited to 100 students and 128 KiB

## Security requirement

Do not import real student passwords over plain HTTP or through a browser that
shows a certificate warning. Use the function with real data only when the
browser displays the official site with valid HTTPS:

```text
https://testing.keilong.edu.hk/nodeapp/
```

If valid HTTPS is not yet available, deployment and local health checks may
still be completed, but use fake test accounts only.

## Phase 1: upload, inspect, install, and test the staged release

Upload these two files to `/home/anthony/` with WinSCP or SFTP:

```text
silent-booth-booking-nodeapp-2.2.0.tar.gz
silent-booth-booking-nodeapp-2.2.0.tar.gz.sha256
```

Then paste this complete block into PuTTY:

```bash
(
set -euo pipefail
cd /home/anthony

ARCHIVE="$HOME/silent-booth-booking-nodeapp-2.2.0.tar.gz"
CHECKSUM="$HOME/silent-booth-booking-nodeapp-2.2.0.tar.gz.sha256"
STAGE="$HOME/silent-booth-booking-nodeapp-2.2.0-stage"

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
test -f public/admin.html
test -f public/admin.js
test -f public/student-csv-import.js
test -f scripts/check-student-csv-import.js
test -f deploy/upgrade-csv-import-2.2.0.sh
test ! -e .env
test "$(node -p "require('./package.json').version")" = '2.2.0'

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
bash -n deploy/upgrade-csv-import-2.2.0.sh
echo 'PHASE 1 PASSED'
)
```

The checksum line must end with `OK`, and the final line must be:

```text
PHASE 1 PASSED
```

Stop and send the complete output for review if any command reports an error.

## Phase 2: protected upgrade with automatic rollback

Phase 2 creates fresh application, environment, and database backups before
briefly restarting the Node service. The Nginx configuration is not touched.
If a switch-time check fails, the script restores the previous application
automatically.

Run Phase 2 only after Phase 1 passes:

```bash
(
set -euo pipefail
STAGE='/home/anthony/silent-booth-booking-nodeapp-2.2.0-stage'
RUNNER='/run/silent-booth-upgrade-csv-import-2.2.0.sh'
UNIT="silent-booth-csv-upgrade-$(date -u +%Y%m%dT%H%M%SZ)"

sudo install -m 0700 -o root -g root \
  "$STAGE/deploy/upgrade-csv-import-2.2.0.sh" "$RUNNER"

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
Upgrade to version 2.2.0 completed successfully.
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
  -u 'silent-booth-csv-upgrade-*' \
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

grep -q 'id="studentCsvPanel"' public/admin.html && \
  echo 'CSV import panel: installed'
```

Expected output includes:

```text
installed version: 2.2.0
active
enabled
{"status":"ok","database":"connected"}
CSV import panel: installed
```

## Phase 4: browser acceptance test

Use a fake student account first.

1. Open the valid HTTPS site and perform a hard refresh.
2. Log in with the working administrator account.
3. Open the administrator panel.
4. Confirm that **從 CSV 批量建立學生帳戶** appears.
5. Select **下載 CSV 範本**.
6. Change the sample row to a unique fake school email, a unique temporary
   password of at least 10 characters, and a fake display name.
7. Select the CSV file. Confirm that the page reports one valid student
   without displaying the password.
8. Confirm the import. The result must say that one account was created and
   zero existing accounts were changed or deleted.
9. Log out and confirm that the fake student can log in but cannot open the
   administrator panel.
10. Log back in as the administrator and remove/deactivate the fake test
    account using the existing account manager.

Only after this test passes should real student data be imported.

## CSV format for real students

The simplest supported format is:

```csv
email,password,display_name
student01@keilong.edu.hk,Unique-Temporary-Password-01,陳大文
student02@keilong.edu.hk,Unique-Temporary-Password-02,李小明
```

To include classes, use:

```csv
email,password,display_name,class_name
student01@keilong.edu.hk,Unique-Temporary-Password-01,陳大文,1A
student02@keilong.edu.hk,Unique-Temporary-Password-02,李小明,1B
```

Do not add a character, role, teacher, or active column. Imported roles are
fixed to `student` by the server.

After a successful real import, securely delete the plaintext password CSV
from the administrator's computer and distribute temporary passwords through
an approved private channel.

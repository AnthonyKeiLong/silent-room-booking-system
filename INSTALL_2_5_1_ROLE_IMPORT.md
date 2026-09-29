# Silent Booth Booking 2.5.1 installation guide

This package upgrades your current **2.4.2** installation. It adds the `role` column to the account CSV template and accepts `student` or `teacher`. A teacher imported this way has the same administrator permissions as an existing teacher. There is no fixed number-of-accounts limit; the upload is processed in the background. The technical CSV upload limit is 512 KiB per file and 2 KiB per record.

The deployment changes the application files only. It does not replace the database, the protected environment file, the Google OAuth credentials, or the Nginx configuration. The installer creates backups and keeps the previous application for rollback.

## 1. Upload the package with FileZilla

Upload both files to `/home/anthony/` on the school server:

- `silent-booth-booking-nodeapp-2.5.1.tar.gz`
- `silent-booth-booking-nodeapp-2.5.1.tar.gz.sha256`

Keep the existing 2.5.0 package and all server backups. Do not delete `/var/www/anthonyapp` manually.

## 2. Open PuTTY and prepare the release

Run this block exactly:

```bash
set -euo pipefail
cd /home/anthony

sha256sum --check silent-booth-booking-nodeapp-2.5.1.tar.gz.sha256

STAGE='/home/anthony/silent-booth-booking-nodeapp-2.5.1-stage'
if [ -e "$STAGE" ]; then
  echo "STOP: staging path already exists: $STAGE"
  exit 1
fi

mkdir -m 0700 "$STAGE"
tar --extract --gzip \
  --file silent-booth-booking-nodeapp-2.5.1.tar.gz \
  --directory "$STAGE" \
  --no-same-owner --no-same-permissions

cd "$STAGE"
npm ci --omit=dev
npm run check
test -f deploy/upgrade-role-import-from-2.4.2.sh
echo 'PHASE 1 PASSED'
```

Expected results include `silent-booth-booking-nodeapp-2.5.1.tar.gz: OK`, `Account CSV checks passed`, `Background import checks passed`, `HTTP import checks passed`, and `PHASE 1 PASSED`.

## 3. Confirm the safe upgrade starting point

Run:

```bash
cd /home/anthony
node -p "'installed version: ' + require('/var/www/anthonyapp/package.json').version"
sudo systemctl is-active silent-booth-booking
sudo systemctl is-enabled silent-booth-booking
if sudo systemctl is-active --quiet silent-booth-booking-preview; then
  echo 'STOP: stop the private preview before continuing.'
  exit 1
fi
```

The installed version must be `2.4.2`, and the production service must be `active` and `enabled`. If the version is different, stop and report the output before running the installer. The package also contains a separate script for servers that are already on 2.5.0; that script is not used for your current server.

## 4. Run the protected upgrade

From `/home/anthony/silent-booth-booking-nodeapp-2.5.1-stage`, run:

```bash
set -euo pipefail
STAGE='/home/anthony/silent-booth-booking-nodeapp-2.5.1-stage'
RUNNER='/run/silent-booth-upgrade-role-from-2.4.2.sh'
UNIT="silent-booth-role-import-upgrade-$(date -u +%Y%m%dT%H%M%SZ)"

sudo install -m 0700 -o root -g root \
  "$STAGE/deploy/upgrade-role-import-from-2.4.2.sh" "$RUNNER"

if sudo systemd-run \
  --unit="$UNIT" \
  --property=Type=exec \
  --wait \
  /bin/bash "$RUNNER" "$STAGE"; then
  RUN_STATUS=0
else
  RUN_STATUS=$?
fi

sudo journalctl -u "$UNIT" -n 300 --no-pager
echo "upgrade unit: $UNIT"
echo "upgrade exit status: $RUN_STATUS"
exit "$RUN_STATUS"
```

The installer checks the existing 2.4.2 files, backs up the application, environment and database, applies the additive Google identity migration, stops the service briefly, installs 2.5.1, and restarts it. Nginx does not need to be reconfigured.

If the command exits with a non-zero status, wait for the script's rollback messages. Do not move or delete application directories manually. Save the `upgrade unit` and `upgrade exit status` lines.

## 5. Verify the live service

Run:

```bash
cd /var/www/anthonyapp
node -p "'installed version: ' + require('./package.json').version"
sudo systemctl is-active silent-booth-booking
sudo systemctl is-enabled silent-booth-booking
curl --fail --silent --show-error http://127.0.0.1:3000/api/health; echo
curl --fail --silent --show-error http://127.0.0.1:3000/nodeapp/api/health; echo
sudo -u silentbooth /usr/bin/node \
  --env-file=/etc/silent-booth-booking.env \
  /var/www/anthonyapp/scripts/check-database.js
```

Expected results are version `2.5.1`, service `active`, service `enabled`, two health responses showing `{"status":"ok","database":"connected"}`, and the database check showing the expected tables and user count. The Google identity column is added only if it is not already present.

## 6. Test the account import in the browser

Open `https://testing.keilong.edu.hk/nodeapp/`, sign in as an existing teacher, and open the administrator panel. The CSV panel should say **學生及教師帳戶** and the downloaded template should have this header:

```csv
email,password,display_name,class_name,role
```

Use unique test addresses first:

```csv
email,password,display_name,class_name,role
teststudent01@keilong.edu.hk,Student-test-2026-01,Test Student,1A,student
testteacher01@keilong.edu.hk,Teacher-test-2026-01,Test Teacher,Staff,teacher
```

The preview should identify one teacher. After import completes, check the administrator account list. The student should be a normal student; the teacher should have administrator access. Do not reuse an email that already exists, because the whole batch is rejected when any email already exists.

After testing, remove the test accounts through the administrator panel if they are not needed. Delete the local CSV because it contains plaintext passwords.

## 7. Verify the database from PuTTY

The import writes directly to the production MariaDB database. Check the roles without printing password hashes:

```bash
sudo mariadb --database=silent_booth_booking -e "
SELECT email, display_name, class_name, role, active, created_at
FROM users
ORDER BY created_at DESC
LIMIT 20;
"
```

Only `role` values `student` and `teacher` should appear. Passwords remain stored as hashes.

## 8. After a successful installation

Keep the generated backup paths printed by the installer and keep the previous release directory until the new version has been tested. The staging directory may be retained for another rollback or removed later after checking the backup locations. Do not run `upgrade-role-import-2.5.1.sh` or the old 2.5.0 upgrade script for this server; use `upgrade-role-import-from-2.4.2.sh`.

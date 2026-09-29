# Silent Booth Booking: school IT handoff

> **Release notice (3 September 2026):** Production was last verified on 2.2.0
> with valid HTTPS. The database, service account,
> systemd unit, administrator, and backup foundation described below have been
> completed. The school's Nginx configuration is fixed: the application deployer
> must not edit, validate, or reload it. Black-box testing of the published URL is
> still required, and the Nginx/TLS owner must validate the active proxy
> configuration. Version 2.3.0 was not deployed. Use
> [UPGRADE_TIMETABLE_2_4_0.md](UPGRADE_TIMETABLE_2_4_0.md) to upgrade directly
> from 2.2.0 to 2.4.0, including the reviewed additive database migration.
> Do not rerun `database/schema.sql` on production. Email notification has been
> deferred; this release uses student in-app notices and requires no SMTP setup.

This document contains the privileged portion of the deployment for the
audited Ubuntu 24.04 school server. It deliberately contains no real
passwords, hostnames, certificate paths, or private keys.

## Historical initial-install scope (24 August 2026)

The following numbered sections document the original installation; they are
not steps to repeat on the existing production site. Anthony subsequently
received sudo access. Use the versioned upgrade guide above for this release.

- Staged application: `/var/www/anthonyapp`, owned by Linux user `anthony`
- Node.js: 24.18.0; verify its executable path before installing the unit
- MariaDB: 10.11.14, active and enabled, listening on `127.0.0.1:3306`
- Nginx: 1.24.0, active and enabled
- Existing Nginx site: Ubuntu `default` only
- `anthony` is intentionally not a sudoer and has no MariaDB login
- Desired application listener: `127.0.0.1:3000`
- Desired database: `silent_booth_booking`
- Desired database principal: `silent_booth_app@127.0.0.1`
- Desired operating-system service account: `silentbooth`

Run these steps only from an authorized administrator session. Do not grant
`anthony` sudo or database-administrator access, and do not expose ports
3000 or 3306.

Replace every uppercase placeholder before activating a configuration.
Never put a real secret in a ticket, email, chat message, screenshot,
repository, shell command argument, or web directory.

## 1. Preflight and application review

Confirm the current state without changing it:

```bash
lsb_release -ds
systemctl is-active mariadb nginx
systemctl is-enabled mariadb nginx
sudo ss -ltnp | grep -E ':(80|443|3000|3306)[[:space:]]'
ls -ld /var/www/anthonyapp
sudo find /var/www/anthonyapp -maxdepth 2 -type f -printf '%P\n' | sort
command -v node
readlink -f "$(command -v node)"
node --version
```

Expected: MariaDB and Nginx are active; MariaDB is on
`127.0.0.1:3306`; nothing is on port 3000; and the application contains
`server.js`, `db.js`, `package-lock.json`, `database/schema.sql`, and
`node_modules`.

Check that no deployment secret or legacy data was placed in the web tree:

```bash
sudo find /var/www/anthonyapp -maxdepth 2 -type f \
  \( -name '.env' -o -name 'data.json*' -o -name '*.pem' -o -name '*.key' \) \
  -print
```

The expected result is no output. Do not display the contents if a file is
found; move it into an approved protected location.

The systemd unit below uses `/usr/bin/node`. If `readlink -f` reports a
different system path, replace `ExecStart` with that absolute system path.
Do not use a Node executable under `/home/anthony` with
`ProtectHome=true`; install an IT-managed system Node runtime instead.

## 2. Check the existing MariaDB state

Do not assume the earlier work was absent merely because `anthony` cannot
authenticate. Check as the MariaDB administrator:

```bash
sudo mariadb -N -e "SELECT VERSION(); SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='silent_booth_booking'; SELECT User, Host FROM mysql.user WHERE User='silent_booth_app';"
```

If the account exists, inspect its current grants:

```bash
sudo mariadb -e "SHOW GRANTS FOR 'silent_booth_app'@'127.0.0.1';"
```

If a database or account already exists with production data, take a
backup and coordinate a maintenance window before rotating credentials.
Do not drop or recreate an existing database. The full schema includes default
mode initialization and is for a fresh installation only. Existing installations
must use the exact reviewed migration for their release.

## 3. Create or normalize the database and limited account

Generate a 64-character hexadecimal password in the authorized session:

```bash
openssl rand -hex 32
```

Store it immediately in the school's approved password manager. Use the
same value for the MariaDB account and protected environment file. Do not
send it back to Anthony or place it in the web directory.

Open an interactive administrator client with client history disabled:

```bash
sudo env MYSQL_HISTFILE=/dev/null mariadb
```

For a fresh setup, or an approved credential rotation, replace
`PASTE_THE_NEW_64_HEX_SECRET_HERE` and run:

```sql
CREATE DATABASE IF NOT EXISTS silent_booth_booking
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'silent_booth_app'@'127.0.0.1'
  IDENTIFIED BY 'PASTE_THE_NEW_64_HEX_SECRET_HERE';

ALTER USER 'silent_booth_app'@'127.0.0.1'
  IDENTIFIED BY 'PASTE_THE_NEW_64_HEX_SECRET_HERE';

REVOKE ALL PRIVILEGES, GRANT OPTION
  FROM 'silent_booth_app'@'127.0.0.1';

GRANT SELECT, INSERT, UPDATE, DELETE
  ON silent_booth_booking.*
  TO 'silent_booth_app'@'127.0.0.1';

SHOW GRANTS FOR 'silent_booth_app'@'127.0.0.1';
EXIT;
```

Do not create an account for `%`, `0.0.0.0`, or another remote host. The
application deliberately uses TCP to `127.0.0.1`, so the account host must
match `127.0.0.1`.

Expected grants are `USAGE` plus only `SELECT`, `INSERT`, `UPDATE`, and
`DELETE` on `silent_booth_booking.*`. The application account must not
have `CREATE`, `ALTER`, `DROP`, `GRANT OPTION`, or global privileges.

## 4. Install and verify the schema

For a fresh, empty installation only, run the schema as the database administrator.
Do not run this command as an upgrade. The root shell performs the
input redirection so this also works after the application tree is no
longer world-readable:

```bash
sudo sh -c 'exec mariadb --database=silent_booth_booking < /var/www/anthonyapp/database/schema.sql'
```

Verify the tables and seeded booking modes:

```bash
sudo mariadb --database=silent_booth_booking -e "SHOW TABLES; SELECT mode_code, mode_name FROM modes ORDER BY mode_code;"
```

Expected tables for a fresh version 2.4.0 installation:

```text
administrative_cancellations
bookings
calendar
cancellations
mode_slots
modes
sessions
timetable_change_previews
timetable_changes
timetable_state
users
```

Do not grant schema-changing privileges to the application account. Future
schema changes remain an administrator-reviewed deployment step.

## 5. Create the dedicated service account and protect the code

Check first:

```bash
getent passwd silentbooth
getent group silentbooth
```

If both commands return no matching account/group, create them:

```bash
sudo adduser --system --group --no-create-home \
  --home /nonexistent --shell /usr/sbin/nologin silentbooth
```

Keep `anthony` as the code owner for approved SFTP deployments, but make
the service's group read-only and remove access for other local users:

```bash
sudo chown -R anthony:silentbooth /var/www/anthonyapp
sudo chmod -R g-w,o-rwx /var/www/anthonyapp
sudo chmod -R g+rX /var/www/anthonyapp
sudo find /var/www/anthonyapp -type d -exec chmod g+s {} +
```

These symbolic modes preserve required owner/executable bits in
`node_modules`; do not replace them with a blanket `chmod 644` after npm
installation. Verify that the service account can read the entry point but
cannot modify it:

```bash
sudo -u silentbooth test -r /var/www/anthonyapp/server.js && echo 'service can read code'
sudo -u silentbooth test ! -w /var/www/anthonyapp/server.js && echo 'service cannot modify code'
```

## 6. Create the protected environment file

Create it as root, readable only by the service group:

```bash
sudo install -m 0640 -o root -g silentbooth /dev/null /etc/silent-booth-booking.env
sudoedit /etc/silent-booth-booking.env
```

Enter the following and replace the password placeholder with the same
64-character hexadecimal secret used in MariaDB:

```text
NODE_ENV=production
PORT=3000
APP_BASE_PATH=/nodeapp
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=silent_booth_booking
DB_USER=silent_booth_app
DB_PASSWORD=PASTE_THE_SAME_64_HEX_SECRET_HERE
SESSION_TTL_HOURS=12
SCHOOL_TIME_ZONE=Asia/Hong_Kong
```

Version 2.4.0 uses `SCHOOL_TIME_ZONE` to enforce the current school-week
booking window: Monday through Saturday, with Sunday closed. The window rolls
over at Monday 00:00 in this time zone. No rolling day-horizon setting is
required.

`APP_BASE_PATH` is normalized to `/nodeapp` without a trailing slash. It
must contain only ordinary URL path segments. Leave it empty only when this
application owns the hostname root.

Verify permissions and placeholder removal without printing the secret:

```bash
sudo stat -c '%A %U:%G %n' /etc/silent-booth-booking.env
if sudo grep -q 'PASTE_THE_SAME' /etc/silent-booth-booking.env; then echo 'ERROR: password placeholder remains'; else echo 'environment placeholder replaced'; fi
sudo -u silentbooth test -r /etc/silent-booth-booking.env && echo 'service can read environment'
sudo -u anthony test ! -r /etc/silent-booth-booking.env && echo 'deployer cannot read database secret'
```

Expected mode/ownership: `-rw-r----- root:silentbooth`. Never use
`Environment=DB_PASSWORD=...` in the unit, because that exposes the secret
through the unit definition.

Test the connection through the application driver without displaying the
password:

```bash
sudo -u silentbooth /usr/bin/node --env-file=/etc/silent-booth-booking.env \
  -e "const db=require('/var/www/anthonyapp/db'); db.verifyDatabaseConnection().then(async()=>{console.log('database connection: ok');await db.pool.end()}).catch(e=>{console.error('database connection failed:',e.code||e.message);process.exit(1)})"
```

If the verified Node path is not `/usr/bin/node`, replace that path in this
test and the unit below.

## 7. Initialize accounts — choose exactly one route

The schema creates no users. Choose either the legacy migration or the new
administrator bootstrap below. Do not run both.

### Route A — Import legacy data

Use this route only if the existing accounts/bookings must be kept. Anthony
places the original file at `/home/anthony/data.json` with mode `0600`; it
must never be under `/var/www`.

Copy it into a service-only import directory:

```bash
sudo install -d -m 0700 -o silentbooth -g silentbooth \
  /var/lib/silent-booth-booking-import
sudo install -m 0600 -o silentbooth -g silentbooth \
  /home/anthony/data.json \
  /var/lib/silent-booth-booking-import/data.json
```

Run the one-time migration before starting the service:

```bash
sudo -u silentbooth /usr/bin/node \
  --env-file=/etc/silent-booth-booking.env \
  /var/www/anthonyapp/scripts/migrate-json.js \
  /var/lib/silent-booth-booking-import/data.json
```

Verify counts without selecting password columns:

```bash
sudo mariadb --database=silent_booth_booking -e "SELECT COUNT(*) AS total_users, SUM(role='teacher') AS teacher_users FROM users; SELECT COUNT(*) AS bookings FROM bookings; SELECT COUNT(*) AS cancellations FROM cancellations;"
```

At least one teacher is required to administer the site. After acceptance
testing and password rotation, handle both plaintext source copies under
the school's retention and secure-disposal policy. Do not rely on `shred`
for SSDs or virtualized storage.

### Route B — Create the first administrator without legacy data

Use this route if the new site should start without legacy users or
bookings. Do not upload `data.json` or `data.json.txt`. From an authorized
interactive terminal run exactly:

```bash
sudo -u silentbooth /usr/bin/node \
  --env-file=/etc/silent-booth-booking.env \
  /var/www/anthonyapp/scripts/create-admin.js
```

The script prompts for email, display name, class/department, and a new
password. Password entry is hidden and must not be supplied as a command
argument. The script aborts if an active teacher already exists.

Verify the result without selecting password columns:

```bash
sudo mariadb --database=silent_booth_booking -e "SELECT email, display_name, class_name, role, active FROM users;"
```

For either route, do not proceed until there is at least one active teacher.

## 8. Install the systemd service

The bundled service template uses the audited path and dedicated account.
Review it before installation:

```bash
sudo systemd-analyze verify /var/www/anthonyapp/deploy/silent-booth-booking.service
grep -nE '^(User|Group|WorkingDirectory|EnvironmentFile|ExecStart)=' \
  /var/www/anthonyapp/deploy/silent-booth-booking.service
```

If Node is not `/usr/bin/node`, replace only the `ExecStart` executable
in the staged template with the verified IT-managed system path and run
the verification again. Install the reviewed file as root, then start it:

```bash
sudo install -m 0644 -o root -g root \
  /var/www/anthonyapp/deploy/silent-booth-booking.service \
  /etc/systemd/system/silent-booth-booking.service
sudo systemd-analyze verify /etc/systemd/system/silent-booth-booking.service
sudo systemctl daemon-reload
sudo systemctl enable --now silent-booth-booking
sudo systemctl status silent-booth-booking --no-pager
```

If startup fails:

```bash
sudo journalctl -u silent-booth-booking -n 100 --no-pager
```

Verify the local health endpoint and listener:

```bash
curl --fail --silent --show-error http://127.0.0.1:3000/api/health
sudo ss -ltnp | grep -E ':(3000|3306)[[:space:]]'
```

Expected health response:

```json
{"status":"ok","database":"connected"}
```

Both listeners must show `127.0.0.1`, not `0.0.0.0` or `[::]`.
This direct `127.0.0.1:3000` health request is the only pre-TLS web test;
do not route password entry through an HTTP or IP-only Nginx site.

## 9. Verify the fixed IT-managed Nginx route and HTTPS

Do not install, edit, validate, or reload Nginx as part of this application
deployment. The school's existing Nginx configuration is externally managed;
its owner must validate it. Black-box testing of the published URL is mandatory.
The bundled `deploy/nginx-site.conf` is a reference note, not an installable
configuration file.

The application-side environment must contain `APP_BASE_PATH=/nodeapp`. The
fixed proxy must preserve that prefix when forwarding to
`http://127.0.0.1:3000`; this matches its existing no-trailing-slash upstream
behavior. The application redirects exact `/nodeapp` requests to `/nodeapp/`
and removes only that prefix before matching its routes.

Before HTTPS is ready, test only the private Node health endpoint:

```bash
curl --fail --silent --show-error http://127.0.0.1:3000/api/health
```

TLS may terminate on this Nginx server or on a trusted school gateway in front
of it. If TLS terminates upstream, local Nginx may use HTTP on the protected hop,
but only the trusted gateway may reach that hop. The gateway and Nginx must
overwrite untrusted forwarding headers, pass the actual client scheme as
`X-Forwarded-Proto: https`, and preserve the public `Host`. Direct clients must
not be able to spoof trusted forwarding headers. Otherwise valid HTTPS POSTs can
fail the application's same-origin check.

The public deployment remains blocked until IT confirms all of the following:

- the externally managed route is `https://BOOKING_HOSTNAME/nodeapp/`;
- the certificate SAN matches the exact hostname users enter, is unexpired,
  serves a complete chain, and is trusted by every intended school device;
- the trusted proxy reports the original HTTPS scheme and public host to Node;
- the existing IP allow/deny policy identifies the real client, including
  when another trusted proxy is in front of Nginx; and
- port 3000 remains reachable only through loopback.

The active configuration must use the standard Nginx variable
`$proxy_add_x_forwarded_for`. The similarly spelled
`$proxy_add_x_forwared_for` is a typo and must not appear in the loaded
configuration.

After IT confirms that contract, validate it without bypassing TLS:

```bash
curl --fail --silent --show-error \
  'https://BOOKING_HOSTNAME/nodeapp/api/health'

curl --silent --show-error --dump-header - --output /dev/null \
  'https://BOOKING_HOSTNAME/nodeapp?probe=1'

curl --fail --silent --show-error --output /dev/null \
  'https://BOOKING_HOSTNAME/nodeapp/'
curl --fail --silent --show-error --output /dev/null \
  'https://BOOKING_HOSTNAME/nodeapp/styles.css'

curl --silent --show-error --dump-header - --output /dev/null \
  'http://BOOKING_HOSTNAME/nodeapp/'

curl --silent --show-error --dump-header - --output /dev/null \
  --request POST \
  --header 'Origin: https://BOOKING_HOSTNAME' \
  'https://BOOKING_HOSTNAME/nodeapp/api/auth/logout'
```

Replace the hostname in every command. The health request must return the JSON;
exact HTTPS `/nodeapp` must return `308` to `/nodeapp/?probe=1`; and the HTML and
CSS requests must succeed. The first HTTP response must be a same-host redirect
to HTTPS. The harmless logout request must return `200` and an expired
`Set-Cookie` containing `Path=/nodeapp/`, `HttpOnly`, `SameSite=Strict`, and
`Secure`; a `403` indicates incorrect scheme or host forwarding. Run these from
an intended, allow-listed client. Do not use credentials, `curl -k`, or `curl -L`;
certificate and redirect validation are part of the gate.

`NODE_ENV=production` intentionally keeps the session cookie `Secure` and
enables CSP insecure-request upgrades, so an HTTP-only route is not a supported
workaround.

## 10. Network and launch checks

Confirm the service is enabled and the listener boundary is intact:

```bash
systemctl is-enabled silent-booth-booking mariadb nginx
systemctl is-active silent-booth-booking mariadb nginx
sudo ss -ltnp | grep -E ':(80|443|3000|3306)[[:space:]]'
```

Expected:

- The public TLS edge accepts approved HTTPS traffic on port 443. Local Nginx
  listens on the port required by the IT-selected topology; it need not listen
  on 443 when a trusted upstream gateway terminates TLS.
- Node listens only on `127.0.0.1:3000`.
- MariaDB listens only on `127.0.0.1:3306`.

Do not add firewall rules for ports 3000 or 3306. Validate from another
computer that those ports are unreachable and that only the approved
hostname serves the application.

Before launch, require Anthony to complete the application acceptance test
in `DEPLOYMENT_GUIDE.md` and rotate every password that was previously
stored in plaintext.

## 11. Secure backup and restore test

Create a root-only backup directory:

```bash
sudo install -d -m 0700 -o root -g root \
  /var/backups/silent-booth-booking
```

Create a transactionally consistent, root-only compressed backup. The
root shell sets `umask 077`, and `pipefail` prevents a failed dump from
looking successful merely because gzip exited cleanly:

```bash
sudo bash -o pipefail -c 'umask 077; stamp=$(date -u +%Y%m%dT%H%M%SZ); mariadb-dump --single-transaction --routines --triggers --events silent_booth_booking | gzip -9 > "/var/backups/silent-booth-booking/booking-${stamp}.sql.gz"'
```

List metadata only, choose one exact filename, and test its compressed
integrity:

```bash
sudo find /var/backups/silent-booth-booking -maxdepth 1 -type f \
  -printf '%m %u:%g %s %p\n'
sudo gzip -t /var/backups/silent-booth-booking/EXACT_BACKUP_FILENAME.sql.gz
```

Files should be mode `600`, owned by `root:root`. Do not use a wildcard for
the restore test and never restore a test dump over the production
database.

Create a separate, deliberately named test database. `CREATE DATABASE`
will fail rather than overwrite it if a previous test was not cleaned up:

```bash
sudo mariadb -e "CREATE DATABASE silent_booth_booking_restore_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
sudo bash -o pipefail -c 'gzip -dc /var/backups/silent-booth-booking/EXACT_BACKUP_FILENAME.sql.gz | mariadb silent_booth_booking_restore_test'
sudo mariadb --database=silent_booth_booking_restore_test -e "SHOW TABLES; SELECT COUNT(*) AS users FROM users; SELECT COUNT(*) AS bookings FROM bookings;"
```

After documenting a successful restore, remove only the explicitly named
test database:

```bash
sudo mariadb -e "DROP DATABASE silent_booth_booking_restore_test;"
```

Put the dump into the school's approved scheduled backup, encrypted
off-server storage, retention, monitoring, and recovery process. A backup
is not accepted until a restore test succeeds.

## 12. Future deployments

For each update:

1. Schedule a maintenance window and back up the database.
2. Let `anthony` upload code and run `npm ci --omit=dev` plus
   `npm run check` without sudo.
3. Review the exact additive schema migration before running it as the
   administrator; never rerun the full fresh-install schema over custom slots.
4. Reapply the group/read-only permission commands from section 5.
5. Restart and inspect the service:

   ```bash
   sudo systemctl restart silent-booth-booking
   sudo systemctl status silent-booth-booking --no-pager
   sudo journalctl -u silent-booth-booking -n 100 --no-pager
   ```

6. Repeat the local health, HTTPS, listener, and application acceptance
   tests.

Never overwrite `/etc/silent-booth-booking.env` with an uploaded file and
never place credentials or legacy data under `/var/www/anthonyapp`.

# Silent Booth Booking: deployment guide for the school server

> **Release notice (3 September 2026):** Production was last verified on version
> 2.2.0 with valid HTTPS. The initial installation below is complete, and the
> prepared 2.3.0 weekly-window update was not deployed. For the combined weekly
> booking and teacher timetable release, upgrade directly from 2.2.0 to 2.4.0
> using [UPGRADE_TIMETABLE_2_4_0.md](UPGRADE_TIMETABLE_2_4_0.md). It includes an
> additive database migration; do not rerun the full schema. Email is deferred:
> this release uses in-app cancellation notices only. Do not use the historical
> initial state below to assess the live server. The deployer must not edit,
> validate, or reload the school-managed Nginx configuration; black-box testing
> of the published URL is still mandatory.

This guide is specific to the server that was inspected on 24 August 2026.
It replaces the earlier generic instructions.

## Historical initial-install state (24 August 2026)

This section is an initial-install record, not instructions to repeat on the
working server. Anthony subsequently received sudo access, and the database,
service, administrator account, and HTTPS website were installed and verified.

- Ubuntu 24.04.4 LTS
- Node.js 24.18.0 and npm 11.16.0
- MariaDB 10.11.14, active and enabled
- MariaDB listens only on `127.0.0.1:3306`
- Nginx 1.24.0, active and enabled
- Only the Ubuntu default Nginx site is currently enabled
- Linux account: `anthony`, with groups `anthony` and `users`
- `anthony` does **not** have `sudo`
- Approved upload directory: `/var/www/anthonyapp`, owned by `anthony`
- `/var/www/anthonyapp` is currently empty
- No application is listening on port 3000
- No `silent-booth-booking` system service exists yet

The failed command `mariadb -e ...` only proves that `anthony` does not
have a MariaDB login. It does not prove whether the application database
was created previously. School IT must check that as a database
administrator.

## Architecture and security boundary

```text
Browser --HTTPS--> trusted TLS edge --> Nginx --> Node/Express on 127.0.0.1:3000
                                                  |
                                                  +--> MariaDB on 127.0.0.1:3306
```

The trusted TLS edge may be local Nginx or a school gateway. Only the selected
trusted proxy path should accept connections from other computers. Ports 3000
and 3306 must remain private to the server. Do not let real users enter passwords
until the final hostname and HTTPS certificate are working.

## Who does what

### Anthony can do

- Upload the prepared application through FileZilla using SFTP.
- Install the locked Node packages in the directory he owns.
- Run the application's code checks.
- Place the legacy `data.json` in his private home directory for a one-time
  migration, if the existing accounts and bookings need to be preserved.
- Perform browser acceptance tests after IT finishes the privileged work.

### School IT must do

- Check or create the MariaDB database and limited application account.
- Install the database schema as a MariaDB administrator.
- Create the dedicated `silentbooth` operating-system account.
- Protect the application files and database environment file.
- Install, start, and restart the systemd service.
- Configure the real Nginx hostname, DNS, and HTTPS certificate.
- Configure and test backups.

Anthony does not need `sudo` or MariaDB administrator access. The exact
administrator procedure is in [IT_HANDOFF.md](IT_HANDOFF.md).

## Phase 1 — Anthony: upload the prepared package

On the Windows computer, extract
`silent-booth-booking-mariadb-ready-2026-08-24.zip`. In FileZilla Site
Manager use:

- Protocol: **SFTP - SSH File Transfer Protocol**
- Host: the same host or IP used in PuTTY
- Port: the same SSH port used in PuTTY, normally `22`
- Login: the same account/key method used in PuTTY

Open the extracted `silent-booth-booking-mariadb-ready-2026-08-24` folder
on the local side. Open `/var/www/anthonyapp` on the server side. Upload
the **contents** of the extracted folder directly into
`/var/www/anthonyapp`; do not create an extra nested dated directory.

Upload these application items:

```text
package.json
package-lock.json
server.js
db.js
public/
database/
deploy/
scripts/
```

Do **not** upload any of the following:

```text
node_modules/
.env
data.json
data.json.txt
*.log
```

The original `data.json` and `data.json.txt` contain sensitive legacy data,
including plaintext passwords. They must never be placed under `/var/www`
or sent to IT in email, chat, a ticket, or a screenshot.

## Phase 2 — Anthony: verify the upload and install packages

In PuTTY:

```bash
cd /var/www/anthonyapp
pwd
find . -maxdepth 2 -type f -printf '%P\n' | sort
```

`pwd` must print:

```text
/var/www/anthonyapp
```

Check that no secret or legacy data file was uploaded accidentally:

```bash
find . -maxdepth 1 -type f \( -name '.env' -o -name 'data.json*' \) -print
```

The expected result is no output. If it prints a filename, stop and keep
the file's contents private while its location is corrected.

Record the actual Node and npm locations for IT:

```bash
command -v node
command -v npm
node --version
npm --version
```

Install the Linux dependencies and run the checks as `anthony`, without
`sudo`:

```bash
npm ci --omit=dev
npm run check
```

Do not upload Windows `node_modules`, and do not run npm as root. If npm
cannot reach its package registry, give the complete error to school IT;
do not work around school network controls.

Confirm the important files now exist:

```bash
test -f server.js && echo 'server.js: present'
test -f database/schema.sql && echo 'schema.sql: present'
test -d node_modules && echo 'node_modules: present'
```

## Phase 3 — Hand the privileged work to school IT

Give IT the file `IT_HANDOFF.md` and these facts:

- Uploaded application path: `/var/www/anthonyapp`
- Application port: `127.0.0.1:3000`
- Database endpoint: `127.0.0.1:3306`
- Requested database: `silent_booth_booking`
- Requested database account: `silent_booth_app@127.0.0.1`
- The database account needs only `SELECT`, `INSERT`, `UPDATE`, and
  `DELETE` on `silent_booth_booking.*`
- The school calendar clock is fixed by `SCHOOL_TIME_ZONE=Asia/Hong_Kong`.
  Version 2.4.0 derives the current Monday-to-Saturday booking window from
  that clock; there is no configurable rolling booking horizon.
- The final public hostname is still required
- Node's exact path is the result of `command -v node`

Do not put the database password into the handoff document or message.
IT should generate it, store it using the school's approved secret-storage
method, and place it directly into the protected environment file.

IT must decide whether `/var/www/anthonyapp` is the permanent application
directory. The administrator handoff uses that audited path and a
dedicated `silentbooth` service account. IT must verify the Node path and set
`APP_BASE_PATH=/nodeapp` in the protected application environment. The school's
existing Nginx configuration is externally managed; do not install, edit,
validate, or reload it from this package. Before IT confirms the fixed `/nodeapp`
route over valid HTTPS, test only the private app endpoint with
`curl http://127.0.0.1:3000/api/health`—not an HTTP login page.

An HTTP production page can appear as bare, unformatted HTML: the production
content-security policy upgrades its CSS, JavaScript, and API requests to HTTPS,
while the login session cookie is `Secure` and cannot work over HTTP. Disabling
that policy, removing `Secure`, or running in development mode is not a safe
production fix. Do not enter a real password on an HTTP or raw-IP page.

## Phase 4 — Choose exactly one account-bootstrap route

The schema intentionally creates no login account. Anthony and IT must
choose **one** of the following routes; do not run both.

### Route A — Preserve the legacy users and bookings

Choose this route only if the users, bookings, calendar, or cancellations
from the original website must be retained.

In FileZilla, upload only the original `data.json` to:

```text
/home/anthony/data.json
```

Do not upload `data.json.txt`. Then, in PuTTY:

```bash
chmod 600 /home/anthony/data.json
ls -l /home/anthony/data.json
```

Do not display or paste the contents. Tell IT that the file is ready. IT
will copy it into a root-controlled import directory, run the provided
migration as `silentbooth`, and verify that at least one teacher account
exists. After login testing and password rotation, IT must retain or remove
both old plaintext copies according to the school's data-retention policy.

### Route B — Start with an empty site and one administrator

Choose this route when no legacy users or bookings should be imported. Do
not upload either legacy data file. In an authorized interactive terminal,
IT runs:

```bash
sudo -u silentbooth /usr/bin/node \
  --env-file=/etc/silent-booth-booking.env \
  /var/www/anthonyapp/scripts/create-admin.js
```

The script asks for the administrator email, display name, department, and
a new password. Password input is hidden. Do not send that password in a
message or put it on the command line. The script refuses to create a
second active teacher; subsequent account management happens in the
administrator page after HTTPS is working.

## Phase 5 — Anthony: confirm the service after IT finishes

IT should tell you the final hostname after the database, service, Nginx,
DNS, and TLS work is complete. The browser address ends in `/nodeapp/`.
From PuTTY, these read-only checks do not need `sudo`:

```bash
systemctl is-active silent-booth-booking
systemctl is-enabled silent-booth-booking
ss -ltn | grep -E ':(3000|3306)[[:space:]]'
curl --fail --silent --show-error http://127.0.0.1:3000/api/health
```

Expected results:

- The service is `active` and `enabled`.
- Node listens on `127.0.0.1:3000`, not `0.0.0.0:3000`.
- MariaDB still listens on `127.0.0.1:3306`, not `0.0.0.0:3306`.
- The health endpoint returns:

```json
{"status":"ok","database":"connected"}
```

Do not publish a temporary IP-only login page. The Ubuntu default Nginx
site is still enabled, and `server_name _` does not safely solve that
routing issue. IT should use the assigned hostname and preserve the
default site unless it deliberately confirms that changing it is safe.

## Phase 6 — Acceptance test over HTTPS

Use temporary student and teacher accounts, then verify all of the
following at the final `https://HOSTNAME/nodeapp/` address:

1. The browser reports a valid certificate whose SAN matches the exact hostname,
   which is unexpired, serves a complete chain, and is trusted by the intended
   school device.
2. HTTP redirects to HTTPS.
3. Both accounts can log in.
4. A student can create a booking.
5. A second account cannot take the same date/time slot.
6. A student cannot exceed two bookings on one day.
7. A student can cancel, and the cancellation appears in the admin page.
8. A teacher can cancel a booking and manage the calendar.
9. IT restarts `silent-booth-booking`; data remains and valid sessions
   remain usable.
10. Ports 3000 and 3306 are not reachable from another computer.
11. IT produces a backup and successfully restores it into a separate
    test database.

Rotate any passwords that previously appeared in `data.json` before the
site is opened to real users.

## Updating the application later

For this release, follow the staged procedure in
[UPGRADE_TIMETABLE_2_4_0.md](UPGRADE_TIMETABLE_2_4_0.md). For a future update:

1. Agree on a maintenance window with IT.
2. Prepare fresh application, environment, and MariaDB backups.
3. Upload to a new, private staging directory, not over the live files.
4. Run `npm ci --omit=dev` and `npm run check` there as `anthony`.
5. Apply only the reviewed additive migration during the maintenance window,
   preserve read-only service permissions, and retain the previous code for
   rollback. Do not rerun the full fresh-install schema on an existing database.
6. Repeat the health and acceptance tests.

Never overwrite the protected environment file, upload a database secret,
or expose ports 3000 or 3306 during an update.

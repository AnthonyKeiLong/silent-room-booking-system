# 2.5.2 teacher-initials hotfix

This release upgrades a running 2.5.1 installation. It keeps `email` as the internal database key, and adds a unique `username` login alias for teachers. Teacher usernames must be 2–4 English letters (for example `ABCD`). Students continue to sign in with their email address.

CSV header:

```csv
email,password,display_name,class_name,role,username
```

For student rows, leave `username` empty. For teacher rows, set `role` to `teacher` and provide a unique 2–4 letter username. The migration is additive and does not delete users or bookings. It does not change Nginx.

Upload the archive and checksum to `/home/anthony/`, verify the checksum, extract to `/home/anthony/silent-booth-booking-nodeapp-2.5.2-stage`, run `npm ci --omit=dev` and `npm run check`, then run the protected installer:

```bash
STAGE='/home/anthony/silent-booth-booking-nodeapp-2.5.2-stage'
RUNNER='/run/silent-booth-upgrade-teacher-usernames-2.5.2.sh'
UNIT="silent-booth-teacher-usernames-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -m 0700 -o root -g root "$STAGE/deploy/upgrade-role-import-from-2.4.2.sh" "$RUNNER"
sudo systemd-run --unit="$UNIT" --property=Type=exec --wait /bin/bash "$RUNNER" "$STAGE"
sudo journalctl -u "$UNIT" -n 300 --no-pager
```

The installer accepts the existing 2.4.2 or 2.5.1 application as its starting point, applies the username migration, backs up the application/environment/database, restarts the service, and verifies health. Keep the printed backup and rollback paths.

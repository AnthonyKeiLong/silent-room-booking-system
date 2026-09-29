# Account import 2.5.1

Based on the preserved 2.5.0 release. Google OAuth and the database schema are unchanged.

The downloadable CSV template now contains:

```csv
email,password,display_name,class_name,role
student01@keilong.edu.hk,,Student 01,1A,student
teacher01@keilong.edu.hk,,Teacher 01,Staff,teacher
```

Fill in unique passwords before importing. Teacher accounts receive the existing administrator permissions. Only authenticated teachers can import accounts. Roles accept student or teacher, ignoring surrounding spaces and letter case. A missing role column in an older CSV defaults to student; an explicit blank or invalid role is rejected. An omitted/blank class_name defaults to Student or Staff according to role.

There is no fixed account-count limit. Each UTF-8 CSV may be up to 512 KiB, with up to 2 KiB per record. Split larger files. Password requirements are those of 2.5.0: at least 10 characters, at most 72 UTF-8 bytes, no control characters, and different passwords per account.

Imports run in the background and show progress. Refreshing the page in the same browser tab resumes polling; do not submit the same file again after a connection interruption. Jobs do not survive a server restart. Check the account list before retrying an interrupted import. An existing email or validation failure prevents the batch from creating accounts; existing accounts are never promoted or overwritten by CSV import.

## Deployment status

This is a local release package, not an installation on the school server. Keep the old 2.5.0 package and server backups. Before deployment, confirm the actual installed version and take app/environment/database backups. The inherited deploy/upgrade-google-oauth-2.5.0.sh targets the older release: do not run that script to install 2.5.1. No schema migration is required for this change.

Changed runtime files: server.js, student-import-jobs.js (new), public/admin.html, public/admin.js, public/student-csv-import.js, package.json and package-lock.json. Deploy these as one release and restart the service; updating only the HTML would leave the server unable to import teacher roles. Keep production environment settings and Google credentials on the server.

Tests: npm run check includes CSV validation, mixed-role HTTP imports over 100 rows, authorization, progress ownership, transaction failure handling and existing Google OAuth/timetable checks. Database writes in import tests use isolated test doubles, not the school database.

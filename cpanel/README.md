# Maintenance form → Firebase sync

The maintenance request form stays where it is — staff keep submitting at:

    https://pnatech.com.my/maintenance/form_aduan/

That PHP form still writes to MySQL. This folder holds the bridge that mirrors
those rows into Firebase so the ERP can show them.

## Files

| File | Purpose |
| --- | --- |
| `sync_maint_firebase.php` | Mirrors the maintenance table into the `maintRequests` Firebase node |

The script is **already uploaded** to `/maintenance/form_aduan/` and has been
run once — the 4 existing records are live in Firebase. All that is left is the
cron job below.

## Install

1. `sync_maint_firebase.php` is already uploaded to
   `/maintenance/form_aduan/`, next to `db_connect.php`. Re-upload it any time
   you change it — pick the **PNA Maintenance Form** profile in the SFTP panel.
2. `firebase_secrets.php` is **not needed** right now. The Realtime Database
   rules are currently open, so the sync authenticates without a token. Create
   that file (chmod 600) only if you later lock the rules down:

   ```php
   <?php
   $FIREBASE_DB_TOKEN = '';
   ```

3. Add the cPanel cron job — every 5 minutes:

   ```
   php /home/pnatech/public_html/maintenance/form_aduan/sync_maint_firebase.php
   ```

   It prints one line per run:

   ```
   [2026-09-29 01:03:33] Read 4 record(s) from MySQL
   [2026-09-29 01:03:33] OK, wrote 4 record(s) to maintRequests
   ```

   Append `?debug=1` in a browser to see the PHP version, extensions and the
   exact column list it selected.

## Schema notes

The live table stores only:

    id, nama, lokasi, tarikh, kerosakkan, gambar,
    status, completed_at, completed_by, created_at

**`jenis_kerosakkan` and `masa_dikesan` are never saved.** `submit.php` only
reads them to build the notification email, so the ERP shows those two as empty
for mirrored records. Capturing them would need an `ALTER TABLE` plus an edit
to `submit.php` — worth doing if staff should see the defect category later.

The script discovers the real columns at runtime, so a future schema change
will not break it.

## Notes

- The sync **replaces** the whole `maintRequests` node each run, so the ERP is
  a strict mirror of MySQL. That is why the ERP page is read-only — edit status
  in `view_requests.php` and it comes back on the next sync.
- Photos are **not** copied into Firebase. Only the filename is mirrored and the
  ERP links to `uploads/<file>` on cPanel, so nothing large is duplicated.
- The script is publicly reachable, so anyone who guesses the URL can trigger a
  sync. It only reads your database and writes to your own Firebase, but add a
  secret path or an `.htaccess` IP/lock if that bothers you.

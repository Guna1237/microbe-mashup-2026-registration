# Hostinger VPS deployment

This app uses Node.js 24, a persistent SQLite database and a background email worker. Use a Hostinger VPS or an equivalent stand-alone Linux host. The steps use a single app instance behind Caddy. A Hostinger domain can point to the server regardless of where the VPS is hosted.

## Install on the VPS

Install Node.js 24, Git and Caddy using their official installation instructions. The service template expects Node at `/usr/bin/node`. Adjust the two `ExecStart` paths if it is elsewhere.

```sh
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin microbe-mashup
sudo install -d -m 0750 -o root -g microbe-mashup /etc/microbe-mashup
sudo install -d -m 0750 -o microbe-mashup -g microbe-mashup /var/lib/microbe-mashup
sudo git clone https://github.com/Guna1237/microbe-mashup-2026-registration.git /opt/microbe-mashup
cd /opt/microbe-mashup
sudo install -m 0640 -o root -g microbe-mashup .env.example /etc/microbe-mashup/mashup.env
sudo node staff.mjs create event-owner owner /etc/microbe-mashup/staff.json
sudo chown root:microbe-mashup /etc/microbe-mashup/staff.json
sudo chmod 0640 /etc/microbe-mashup/staff.json
sudoedit /etc/microbe-mashup/mashup.env
```

Save the generated passphrase privately. Create other named staff accounts using `payments` or `checkin` as the role. After changing or removing accounts, reapply file ownership and permissions above and restart the app so old sessions are revoked.

In the environment file set:

- `DEMO=0`, `RAZORPAY_TEST=0`, `PUBLIC_URL=https://register.yourdomain.com`, `PORT=8108` and `TRUST_LOOPBACK_PROXY=1` for the supplied Caddy setup.
- `DATA_DIR=/var/lib/microbe-mashup` and `STAFF_FILE=/etc/microbe-mashup/staff.json`.
- The confirmed fee amounts, followed by `PRICES_CONFIRMED=true`.
- `PAYMENT_MODE=manual`, the organizer's verified `MANUAL_UPI_ID` and `MANUAL_PAYEE`, and optionally an absolute path to the verified UPI PNG. Store that PNG outside the Git checkout, where the service can read it.
- The verified Brevo `BREVO_SENDER_EMAIL`, `BREVO_API_KEY` and `REPLY_TO=mams.microbemashup@gmail.com`. Set `MAIL_PAUSED=1` if you're rehearsing with the recovered database and don't want that rehearsal to send messages.

Keep the application port inaccessible from the internet. The app listens on loopback. Allow HTTPS and HTTP on ports 443 and 80 for Caddy, along with your restricted admin SSH access. Use the supplied Caddy config with your real hostname in place of `register.example.com`. On a VPS already hosting sites, add this site block to the existing Caddy configuration.

In Hostinger DNS, add an A record for the registration subdomain pointing to the VPS's IPv4 address. Add an AAAA record only if the VPS has working IPv6. Leave unrelated records in place. Caddy can obtain the certificate once DNS points to the VPS and both ports are reachable. [Hostinger DNS guidance](https://www.hostinger.com/support/how-to-point-a-domain-to-a-vps/) · [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

```sh
sudo install -m 0644 deploy/microbe-mashup.service /etc/systemd/system/microbe-mashup.service
sudo systemctl daemon-reload
sudo systemctl enable --now microbe-mashup
sudo systemctl status microbe-mashup
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -fsS https://register.yourdomain.com/healthz
```

Before circulating the URL, verify the named staff roles and the receiving account. Complete one private end-to-end registration and workshop from a phone. Check the UPI verification workflow against the bank, the actual email inbox, and the roster export.

## Backup and restore

Take backups before updates and on a schedule during registration. Run the following on the VPS with a new filename. This uses SQLite to capture a consistent snapshot even while the app is running.

```sh
sudo -u microbe-mashup /usr/bin/node --env-file=/etc/microbe-mashup/mashup.env /opt/microbe-mashup/server.mjs backup /var/lib/microbe-mashup/backup-2026-12-01.sqlite
sudo -u microbe-mashup /usr/bin/node /opt/microbe-mashup/ops.mjs /var/lib/microbe-mashup/backup-2026-12-01.sqlite
```

Verify each snapshot, and keep a protected off-server copy. Back up the staff and environment files separately in encrypted storage. The SQLite snapshot contains attendee and payment records.

To restore, verify the snapshot, stop the service and preserve the old data directory with its SQLite sidecar files. Place the snapshot in a fresh private data directory as `mashup.sqlite`. Set the new `DATA_DIR` and use `MAIL_PAUSED=1` during the rehearsal. With a stale backup, compare later bank payments and the Brevo delivery log before resuming email or accepting registrations. Once reconciled, enable email and restart. Never copy only an active SQLite file while WAL writes may still be pending.

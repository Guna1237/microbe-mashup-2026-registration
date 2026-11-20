# Hostinger managed Node.js hosting

Use this setup when hPanel shows a GitHub import and a framework preset. For a VPS, use the [VPS runbook](HOSTINGER.md).

## Create private storage before the first deploy

Connect using the SSH command and verified fingerprint shown in hPanel. Run these commands on the host:

```sh
umask 077
mkdir -p "$HOME/microbe-mashup-data"
git clone https://github.com/Guna1237/microbe-mashup-2026-registration.git "$HOME/microbe-mashup-setup"
node "$HOME/microbe-mashup-setup/staff.mjs" create event-owner owner "$HOME/microbe-mashup-data/staff.json"
printf 'DATA_DIR=%s\nSTAFF_FILE=%s\n' "$HOME/microbe-mashup-data" "$HOME/microbe-mashup-data/staff.json"
```

Store the generated passphrase privately. Keep SQLite, the staff file, the optional QR image and any job configuration outside the managed build and public web folders. Before collecting payments, confirm that the host can write to the data directory and that a synthetic registration survives a redeploy. [Hostinger deployment file structure](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/)

## Import the web app

Use the Other preset, Node.js 24.x, root `./`, entry file `server.mjs` and no build command or output directory. Use the app port assigned by Hostinger. Set `PUBLIC_URL=https://microbemashup.org`, `DEMO=0`, `PAYMENT_MODE=manual`, `RAZORPAY_TEST=0` and `JOB_MODE=cron`. Use the absolute paths printed above for `DATA_DIR` and `STAFF_FILE`. Set the confirmed prices, verified UPI details, verified Resend sender and Resend API key in hPanel.

## Schedule payment and email jobs

Managed Node.js hosting uses scheduled jobs for background work. Save a private copy of the required hPanel variables as `$HOME/microbe-mashup-data/job.env` and restrict it to your user with `chmod 600`. Do not put handles, keys or private QR files into the repository. This env file needs the same fees, sender, staff path and data path as the web app. Use `MAIL_PAUSED=1` for staging runs and `0` after the mail provider is ready.

In SSH, confirm `command -v node` identifies Node 24 with `node --version`. Use the actual absolute Node executable path, account home directory and domain in the hPanel cron job instead of the placeholders below:

```sh
/path/to/node --env-file=/home/ACCOUNT/microbe-mashup-data/job.env /home/ACCOUNT/domains/microbemashup.org/hbuilds/current/nodejs/server.mjs jobs:drain
```

Run the job manually once, then schedule it every minute if your plan allows it. The command exits after a bounded pass and a database lease prevents overlapping jobs from sending duplicates. Use the current deployment symlink so future releases update the worker code as well. After scheduling, verify an organizer approval sends its confirmation and unlocks workshops with the browser closed. [Hostinger Node.js limits](https://www.hostinger.com/support/hostinger-node-js-limits-for-web-and-cloud-plans/)

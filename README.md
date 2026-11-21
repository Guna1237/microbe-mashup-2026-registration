# Microbe Mashup ’26 registration

Two forms on one website for the 11–12 December 2026 student summit hosted by the Department of Microbiology at Mamata Academy of Medical Sciences.

- **Basic Registration** is mandatory. Individuals pay ₹800. Groups of 3 or 4 pay ₹750 per person, and groups of 5 pay ₹700 per person. One leader submits the group details and pays once. After verification, every member receives their own `MMSPH-###` ID and private booking link.
- **Events & Workshops** verifies the attendee’s private link and their own Registration ID. Eligible attendees can choose events, including the three-person Microbe Mayhem competition, and workshops. Selected activities share one checkout, with duplicate activity bookings prevented.
- **Payments** use organizer-verified UPI by default. Attendees enter their UPI reference, and organizers approve only after matching the settled payment against the receiving account. Razorpay is available as an optional alternative.
- **Email** uses Resend with a persistent queue. The acknowledgment contains the payment-status link. The verified Basic Registration email contains the individual ID, private booking link, and any configured WhatsApp invite. Verified activity orders get a separate confirmation with the selected items.

Place the official Summit Brochure at `public/summit-brochure.pdf` and redeploy. The brochure page displays an availability message until that file is present.

## Preview

Install Node.js 24 or later. Copy `.env.example` to `.env` and run `npm start`. Open `http://127.0.0.1:8108` and use a made-up transaction reference. Sign into `http://127.0.0.1:8108/admin` with the username `organizer` and preview passphrase `mashup-local-preview-only`. Demo mail is written to `demo-data/outbox.jsonl`. Demo mode binds to loopback and uses a different database from production. Production requires a separate staff file.

Run `npm test` to exercise 525 synthetic registrations, all three group rates, individual ID delivery and booking access, staff permissions, payment verification, check-in, and SQLite backup and restore. Tests use temporary data and either pause email or send it to a local outbox.

## Manual UPI payment and verification

1. Use `PAYMENT_MODE=manual`. Before publishing, set `MANUAL_UPI_ID` and `MANUAL_PAYEE` to the organizer's verified receiving account details. To display the existing QR, set `MANUAL_QR_FILE` to the absolute path of that account's PNG QR image. Preview uses no real payment details.
2. The attendee sees the exact amount, pays by UPI, and enters the transaction reference. The site prevents one reference from being used for multiple orders. A submitted reference leaves the order pending.
3. Open **Organizer dashboard → Orders & check-in → Needs payment review**. Match the UPI reference and credited amount against the bank or merchant app. Choose **Verify**, type the credited amount and confirm the match. Choose **Request correction** to send a payment-status link with the reason. Basic approval unlocks Events & Workshops for each participant. Review each combined activity checkout the same way.

   The same approval is available on the host if the dashboard is unavailable:

   ```powershell
   npm run verify-payment -- ORDER_REFERENCE VERIFIED_UPI_REFERENCE EXACT_AMOUNT_IN_RUPEES
   ```

   The command requires all three values to match and queues the confirmation email once.

## Organizer dashboard

- Search by name, email, attendee ID, order reference or UPI reference. Use **Summit check-in** at the entrance. Check-in is available only to verified summit attendees.
- Pause or reopen Basic Registration and Events & Workshops independently. Existing orders can still be paid.
- Open **Event & workshop roster** to see paid and awaiting-payment counts by activity. **View bookings** opens the filtered order list. Use **Summit check-in** to mark each group member separately.
- **Owners** manage registration, payment reviews, check-in, the email queue, the private roster export and the activity log. **Payment reviewers** can review, approve and request corrections. **Check-in staff** see only paid summit attendees' names, IDs and check-in status. The log identifies the staff account behind each dashboard change.
- Owners can retry recent failed mail sends. For older failures, check the mail provider's delivery log before sending again.
- To add or rotate a staff account, run `npm run staff:create -- USER ROLE ABSOLUTE_STAFF_FILE`. To revoke an account, run `npm run staff:remove -- USER ABSOLUTE_STAFF_FILE`. Restart the service to apply changes and revoke existing sessions.

## Optional Razorpay checkout

1. In the [Razorpay Dashboard](https://dashboard.razorpay.com/), select **Test Mode**, then **Account & Settings → API Keys → Generate Key**. Keep the key secret in your local `.env`.
2. Set `DEMO=0`, `PAYMENT_MODE=razorpay`, `RAZORPAY_TEST=1`, `RAZORPAY_KEY_ID=rzp_test_…` and `RAZORPAY_KEY_SECRET` to the corresponding secret. Save the file.
3. Run `npm run check-razorpay`. This makes a read-only API request and prints whether Razorpay accepts the credentials.
4. Run `npm start`, open `http://127.0.0.1:8108` and submit a test registration. Use the hosted Razorpay test checkout, then check the registration page for verification. Local Test Mode writes email to `razorpay-test-data/outbox.jsonl` and keeps test records in that folder. You can use test mode without a Resend account or a public domain.

For real payments, set `RAZORPAY_TEST=0` and use `rzp_live_…` credentials after completing the launch steps below.

## Confirm before launch

The original form lists conflicting fee amounts. The preview follows the workshop selection labels and uses the ₹800 summit total from the previous discussion. These are provisional.

| Fee | Preview | Other value in source |
| --- | ---: | ---: |
| Summit | ₹800 | ₹799 |
| IPC in Action | ₹2,500 | ₹2,200 |
| Antibiotic IQ | ₹2,200 | ₹2,500 |
| Beyond the White Coat | ₹4,999 | ₹5,000 |

The other competition fees follow the source form. The basic fee applies to all batches. 2k24 BDS, Final Year / Interns and Microbiology PGs skip competitions and can book workshops after summit payment. Confirm this reading of the source gate and confirm whether workshops have capacities or schedule conflicts before launch. This build does not enforce unprovided caps or schedules. Batch eligibility is based on the declared batch. Staff can check college ID at the venue.

If the old form has submissions or assigned IDs, export it before cutting over. Keep using its existing process for payments already sent to the old QR, and set `FIRST_ATTENDEE_NUMBER` above the highest ID already issued. For the paid roster, prepare a private JSON array with `attendeeId`, `name`, `email`, `batch` (`mbbs24`, `mbbs25`, `bds24`, `final` or `pg`) and `amountPaise` (for example, `80000` for ₹800). Include only payments already matched against the receiving account. Run `npm run import-paid -- paid-roster.json` to preserve IDs and grant eligibility, then repeat with `--send-invites` to queue their personal workshop links. The same rows can be safely re-imported, and conflicting IDs or email addresses abort the entire batch. Import before accepting new registrations whenever possible.

## Deploy using the Hostinger domain

Use the [Hostinger VPS runbook](deploy/HOSTINGER.md) for Caddy and systemd, or the [managed Node.js runbook](deploy/HOSTINGER-MANAGED.md) for GitHub import with cron.

1. Use a Node.js 24 host with a persistent writable disk and one always-running app instance. A Hostinger VPS can host the app with HTTPS through a reverse proxy, or you can run it elsewhere and use Hostinger only for the domain. On another host, add a subdomain such as `register.yourdomain.com` in the host's dashboard and add its requested DNS record at Hostinger. Keep existing mail records. This server needs filesystem storage and a background worker.
2. For the public app, configure `DEMO=0`, `RAZORPAY_TEST=0`, `PUBLIC_URL=https://register.yourdomain.com`, and an absolute `DATA_DIR` on the persistent disk. Use one app process per database. Terminate TLS at the proxy. Set `TRUST_LOOPBACK_PROXY=1` only when that proxy sets its own forwarding headers, as the supplied Caddy configuration does. Keep the database on private storage with backups.
3. Configure the verified UPI details or the Razorpay credentials for your chosen payment mode. Set the mode before taking registrations and reconcile pending orders before changing modes. Add the verified sender in Resend and set `RESEND_API_KEY`, `MAIL_FROM` and `REPLY_TO=mams.microbemashup@gmail.com`. Generate named staff accounts into the private `STAFF_FILE`. Set `WHATSAPP_URL` if the existing invite is still valid. Keep credentials out of source.
4. Enter all four confirmed fee values and set `PRICES_CONFIRMED=true`. Production startup requires the pricing, mail, payment and storage settings. Run `npm start` with a service manager that restarts the app after faults. Use live Razorpay keys only when ready to take real payments.
5. Check `/healthz` through the public HTTPS proxy. Test privately from a phone before sharing the URL. Submit a payment reference, verify it from the admin dashboard, and check the real inbox for the ID and private workshop link. Repeat for a workshop and verify that the export shows both paid records. Test the three staff roles and check the mail allowance for opening-day traffic.

See [Razorpay Payment Links](https://razorpay.com/docs/api/payments/payment-links/) and [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email).

## Organizer operations

- Run `npm run --silent export` on the host to export registrations and payment status as JSON. The export includes applicant contact and team details, so store it privately. Filter `product === 'summit' && state === 'paid'` for check-in.
- Monitor Razorpay payment status and Resend delivery/limits. The site sends up to two summit emails and three workshop confirmations per attendee. At 500 registrations that is approximately **1,000 summit emails**, plus workshops. Choose a sender plan with sufficient opening-day volume.
- For manual payments, use the receiving account statement as the source for verification. The website accepts a UPI reference and does not collect screenshots.
- Resend retries use a persistent idempotency key. Mail jobs outside its deduplication window stop and require checking the provider's delivery log before a resend. An expired or cancelled Razorpay link directs the attendee to the organizers.

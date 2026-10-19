# Ticky server

Registration, verified UPI payments and door check-in for the static pages in
the repo root. It replaces the Google Apps Script + Sheet backend and speaks
the same API, so `scan.html`, `dash.html` and `admin.html` work unchanged.

## What changed for the person buying a ticket

Before: scan a static UPI QR, pay, upload a screenshot, get a ticket. Nobody
checked the screenshot, so an edited or reused one got a ticket too.

Now: fill in the form, tap **Pay and get my ticket**, pay on the
[YouPI PG](https://github.com/youpi-pg/YouPI-PG) checkout from any UPI app,
and land back on the page. The ticket appears once YouPI has seen the bank's
credit alert for that exact amount. No gateway fee: money goes straight to the
organiser's UPI ID.

## How a payment is verified

1. `register` stores the details as `PENDING_PAYMENT` and asks YouPI to open a
   checkout for the **server's** ticket price (the browser never sends an
   amount).
2. YouPI shows a dynamic UPI QR, then watches the receiving account's bank SMS
   / notifications / Gmail for the credit.
3. YouPI posts a signed `SUCCESS` to `/youpi/webhook`. This server checks the
   HMAC over the raw body, that the method is `UPI` (not COD), that the order
   and registration match, and that the amount is exactly the ticket price.
   Only then is a ticket issued.
4. If the webhook is late or never comes, the registration page's polling makes
   this server ask YouPI directly (`GET /api/v1/payments/:id` with the merchant
   key) and apply the same checks.

Entry QRs are signed with `TICKET_SECRET`; the door rejects anything this
server did not sign, and anything from another edition.

YouPI calls itself experimental and suggests no more than ~20 payments a day
per receiving account. That fits a dinner. Keep an eye on the YouPI admin
panel for anything flagged suspicious, and reconcile against the bank
statement after the event.

## Run it

Needs Node 22.13+ (for the built-in SQLite) and a running YouPI PG instance
with an active receiving UPI account and at least one observer (the Android
app or Gmail) connected — see YouPI's README.

```bash
cd server
pnpm install
cp .env.example .env    # fill it in
pnpm start
```

Then:

- In `config.js` at the repo root, set `API_BASE` to `<PUBLIC_URL>/api`.
- In YouPI's Merchant Admin, set the merchant webhook URL to
  `<PUBLIC_URL>/youpi/webhook`, and copy its merchant id and webhook secret
  into `.env`. YouPI refuses to deliver webhooks to private addresses; if both
  run on one machine, either use the public tunnel URL or start YouPI with
  `YOUPI_ALLOW_PRIVATE_WEBHOOKS=true`. (Polling still issues tickets without
  the webhook, just a few seconds later.)
- YouPI must be reachable from buyers' phones (its checkout portal), and this
  server from the registration site. A Cloudflare Tunnel on the machine running
  both is the cheapest way.

Data lives in `DATA_DIR` (`ticky.sqlite` plus uploaded backgrounds). Abandoned
checkouts are deleted after a day, and the whole edition after `endsAt` plus
`purgeAfterHours`.

```bash
pnpm test
```

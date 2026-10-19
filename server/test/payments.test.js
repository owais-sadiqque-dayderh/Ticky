/**
 * The promise this server makes: no ticket until YouPI says the right amount
 * arrived over UPI, and the door only admits tickets this server signed.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { ticketPayload } from '../src/tickets.js';
import { createYoupiClient } from '../src/youpi.js';

const WEBHOOK_SECRET = 'whsec_test_0123456789abcdef';
const STAFF = 'DOOR-42-CHICKEN';

/** Stands in for YouPI's payment API: remembers sessions, answers lookups. */
function fakeYoupi() {
  const sessions = new Map();
  const real = createYoupiClient({ apiUrl: 'http://unused', merchantId: 'm1', webhookSecret: WEBHOOK_SECRET });
  return {
    sessions,
    created: [],
    verifyWebhook: real.verifyWebhook,
    // Like YouPI: an order id with an open session gets that session back; once
    // it is over, a new session opens under "<base>-R<4 digits>".
    async createPayment(req) {
      this.created.push(req);
      const existing = [...sessions.values()].find((s) => s.orderId === req.orderId);
      if (existing && !['FAILED', 'EXPIRED', 'CANCELLED'].includes(existing.status)) {
        return { ...existing, checkoutUrl: `http://pay.test/checkout/${existing.paymentId}` };
      }
      const orderId = existing ? `${req.orderId.replace(/-R\d+$/, '')}-R${1000 + sessions.size}` : req.orderId;
      const paymentId = crypto.randomUUID();
      sessions.set(paymentId, {
        paymentId, orderId, amountPaise: String(req.amountPaise), currency: req.currency,
        status: 'INITIATED', method: 'UPI', metadata: req.metadata
      });
      return { paymentId, orderId, status: 'INITIATED', checkoutUrl: `http://pay.test/checkout/${paymentId}` };
    },
    async getPayment(id) {
      const s = sessions.get(id);
      if (!s) throw new Error('not found');
      return { ...s };
    }
  };
}

describe('Ticky server', () => {
  let server, base, youpi, dataDir;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticky-test-'));
  });

  beforeEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    youpi = fakeYoupi();
    const config = loadConfig({
      TICKET_SECRET: 'x'.repeat(40), STAFF_KEY: STAFF, PUBLIC_URL: 'http://localhost:1', SITE_URL: 'http://localhost:2',
      YOUPI_API_URL: 'http://unused', YOUPI_MERCHANT_ID: 'm1', YOUPI_WEBHOOK_SECRET: WEBHOOK_SECRET, DATA_DIR: dataDir
    });
    const quiet = { info() {}, warn() {}, error() {} };
    const app = createApp({ config, db: openDatabase(':memory:'), youpi, log: quiet });
    server = http.createServer(app.handle);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const post = async (body) => (await fetch(`${base}/api`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) })).json();
  const get = async (params) => (await fetch(`${base}/api?${new URLSearchParams(params)}`)).json();

  function webhook(payload, { secret = WEBHOOK_SECRET, deliveryId = crypto.randomUUID() } = {}) {
    const raw = JSON.stringify(payload);
    const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    return fetch(`${base}/youpi/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gateway-Signature': signature, 'X-Gateway-Delivery-Id': deliveryId },
      body: raw
    });
  }

  async function registerOne(email = 'asha@example.com') {
    const res = await post({ action: 'register', name: 'Asha Rao', email, phone: '98765 43210', extra: {} });
    assert.equal(res.ok, true, res.error);
    const [session] = [...youpi.sessions.values()].filter((s) => s.metadata.registrationId === res.ref);
    return { res, session };
  }

  function successFor(session, overrides = {}) {
    return {
      event: 'SUCCESS', paymentId: session.paymentId, orderId: session.orderId, amount: '100.00',
      amountPaise: Number(session.amountPaise), currency: 'INR', method: 'UPI',
      completedAt: new Date().toISOString(), metadata: session.metadata, ...overrides
    };
  }

  test('submitting the form opens a payment for the server-side price and issues nothing', async () => {
    const { res, session } = await registerOne();
    assert.equal(res.pending, true);
    assert.match(res.checkoutUrl, /^http:\/\/pay\.test\/checkout\//);
    assert.equal(session.amountPaise, '10000');
    assert.equal(youpi.created[0].metadata.registrationId, res.ref);

    const status = await get({ action: 'ticketStatus', ref: res.ref, token: res.token });
    assert.equal(status.status, 'PENDING');
    assert.equal(status.ticketId, undefined);

    const stats = await get({ action: 'stats', staffKey: STAFF });
    assert.equal(stats.counts.registered, 0);
    assert.equal(stats.counts.pending, 1);
  });

  test('a forged webhook is refused and issues nothing', async () => {
    const { res, session } = await registerOne();
    const forged = await webhook(successFor(session), { secret: 'not-the-secret' });
    assert.equal(forged.status, 401);
    assert.equal((await get({ action: 'ticketStatus', ref: res.ref, token: res.token })).status, 'PENDING');
  });

  test('a signed SUCCESS for the wrong amount or a COD order issues nothing', async () => {
    const { res, session } = await registerOne();
    assert.equal((await webhook(successFor(session, { method: 'COD' }))).status, 200);
    assert.equal((await webhook(successFor(session, { amountPaise: 100 }))).status, 200);
    const status = await get({ action: 'ticketStatus', ref: res.ref, token: res.token });
    assert.equal(status.status, 'PENDING');
    assert.equal(status.paymentState, 'AMOUNT_MISMATCH');
  });

  test('a signed UPI SUCCESS for the right amount issues one ticket the door admits once', async () => {
    const { res, session } = await registerOne();
    const deliveryId = crypto.randomUUID();
    assert.equal((await webhook(successFor(session), { deliveryId })).status, 200);
    assert.equal((await webhook(successFor(session), { deliveryId })).status, 200); // YouPI retry

    const status = await get({ action: 'ticketStatus', ref: res.ref, token: res.token });
    assert.equal(status.status, 'ISSUED');
    assert.match(status.ticketId, /^TKY-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);

    // Someone else's token sees nothing.
    assert.equal((await get({ action: 'ticketStatus', ref: res.ref, token: 'guess' })).ok, false);

    // The QR is drawn on this server, never by a third-party image host.
    assert.match(status.qrUrl, /^data:image\/png;base64,/);
    const stats0 = await get({ action: 'stats', staffKey: STAFF });
    const payload = ticketPayload('x'.repeat(40), stats0.event.id, status.ticketId);
    const first = await post({ action: 'checkin', payload, staffKey: STAFF });
    assert.equal(first.state, 'VALID');
    assert.equal(first.name, 'Asha Rao');
    assert.equal((await post({ action: 'checkin', payload, staffKey: STAFF })).state, 'ALREADY_USED');
    assert.equal((await post({ action: 'checkin', ticketId: status.ticketId.toLowerCase(), staffKey: STAFF })).state, 'ALREADY_USED');

    const tampered = payload.replace(status.ticketId, 'TKY-2222-2222');
    assert.equal((await post({ action: 'checkin', payload: tampered, staffKey: STAFF })).state, 'INVALID');
    assert.equal((await post({ action: 'checkin', payload, staffKey: 'WRONG' })).code, 'FORBIDDEN');

    const stats = await get({ action: 'stats', staffKey: STAFF });
    assert.deepEqual([stats.counts.registered, stats.counts.checkedIn], [1, 1]);

    // One ticket per email.
    const again = await post({ action: 'register', name: 'Asha Rao', email: 'ASHA@example.com', phone: '9876543210' });
    assert.equal(again.field, 'email');
  });

  test('when the webhook never arrives, polling asks YouPI and issues on a confirmed UPI payment', async () => {
    const { res, session } = await registerOne();
    youpi.sessions.get(session.paymentId).status = 'SUCCESS';
    const status = await get({ action: 'ticketStatus', ref: res.ref, token: res.token });
    assert.equal(status.status, 'ISSUED');
  });

  test('a failed payment can be retried, and a closed form takes no new registrations', async () => {
    const { res, session } = await registerOne();
    youpi.sessions.get(session.paymentId).status = 'EXPIRED';
    const status = await get({ action: 'ticketStatus', ref: res.ref, token: res.token });
    assert.equal(status.canRetry, true);

    const retry = await post({ action: 'retryPayment', ref: res.ref, token: res.token });
    assert.equal(retry.pending, true);
    assert.notEqual(retry.checkoutUrl, res.checkoutUrl);

    // "Back to the payment" reopens the retry rather than starting a third session.
    const reopened = await post({ action: 'retryPayment', ref: res.ref, token: res.token });
    assert.equal(reopened.checkoutUrl, retry.checkoutUrl);

    // And the retry, paid under YouPI's "-R" order id, still issues the ticket.
    const retrySession = [...youpi.sessions.values()].find((s) => retry.checkoutUrl.endsWith(s.paymentId));
    assert.match(retrySession.orderId, /-R\d{4}$/);
    assert.equal((await webhook(successFor(retrySession))).status, 200);
    assert.equal((await get({ action: 'ticketStatus', ref: res.ref, token: res.token })).status, 'ISSUED');

    assert.equal((await post({ action: 'registration', open: false, staffKey: STAFF })).open, false);
    const closed = await post({ action: 'register', name: 'Ravi K', email: 'ravi@example.com', phone: '9876543210' });
    assert.equal(closed.code, 'CLOSED');
  });

  test('going back to a payment that already went through issues the ticket instead of a new session', async () => {
    const { res, session } = await registerOne();
    youpi.sessions.get(session.paymentId).status = 'SUCCESS';
    const retry = await post({ action: 'retryPayment', ref: res.ref, token: res.token });
    assert.equal(retry.status, 'ISSUED');
    assert.equal(youpi.created.length, 1);
  });

  test('wrong door codes from one address are capped, but a signed-in device keeps working', async () => {
    const signedIn = await get({ action: 'stats', staffKey: STAFF.toLowerCase() });
    assert.match(signedIn.staffToken, /^ST[0-9A-F]{64}$/);
    assert.equal((await get({ action: 'stats' })).staffToken, undefined);

    for (let i = 0; i < 10; i++) assert.equal((await get({ action: 'stats', staffKey: 'GUESS-' + i })).staff, false);
    assert.equal((await get({ action: 'stats', staffKey: STAFF })).staff, false);
    assert.equal((await post({ action: 'checkin', ticketId: 'TKY-2222-2222', staffKey: STAFF })).code, 'FORBIDDEN');

    assert.equal((await get({ action: 'stats', staffKey: signedIn.staffToken })).staff, true);
    assert.equal((await post({ action: 'checkin', ticketId: 'TKY-2222-2222', staffKey: signedIn.staffToken })).state, 'UNKNOWN');
    assert.equal((await get({ action: 'adminConfig', staffKey: signedIn.staffToken })).ok, true);
  });

  test('a short door code is refused at boot', () => {
    assert.throws(() => loadConfig({
      TICKET_SECRET: 'x'.repeat(40), STAFF_KEY: 'DOOR-42', PUBLIC_URL: 'http://localhost:1', SITE_URL: 'http://localhost:2',
      YOUPI_API_URL: 'http://unused', YOUPI_MERCHANT_ID: 'm1', YOUPI_WEBHOOK_SECRET: WEBHOOK_SECRET
    }), /STAFF_KEY/);
  });
});

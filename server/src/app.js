/**
 * The API the static pages call (same actions and shapes the Apps Script Web
 * App answered), plus the YouPI webhook.
 *
 * Like the old backend, every POST is a "simple request" — Content-Type
 * text/plain carrying JSON — so browsers never send a CORS preflight.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Store } from './db.js';
import {
  DEFAULT_EVENT, adminEvent, applyEventPatch, cleanFormFields, istIso, istTime,
  newEventId, publicEvent, readAnswers, registrationState
} from './event.js';
import { DEFAULT_THEME, THEME_OPTIONS, cleanTheme, resolveTheme } from './theme.js';
import { newSecret, newTicketId, qrDataUrl, readTicketPayload, safeEqual, ticketPayload } from './tickets.js';
import { baseOrderId } from './youpi.js';

const MAX_API_BODY = 8 * 1024 * 1024;     // a 4 MB background, base64'd, with room to spare
const MAX_WEBHOOK_BODY = 64 * 1024;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const RECONCILE_EVERY_MS = 4000;
const STALE_PENDING_MS = 24 * 3600 * 1000;
const STAFF_TRIES = 10;                   // wrong door codes per address before a pause
const STAFF_PAUSE_MS = 15 * 60 * 1000;

const UPLOAD_TYPES = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg'
};
const UPLOAD_MIME = Object.fromEntries(Object.entries(UPLOAD_TYPES).map(([type, ext]) => [ext, type]));

const RULES = {
  name: (v) => (v.trim().length >= 2 ? null : 'Tell us the name that should appear on the ticket.'),
  email: (v) => (/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(v.trim()) ? null : 'That email will not receive the ticket. Check it once more.'),
  phone: (v) => {
    const digits = v.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 13 ? null : 'We need a 10-digit mobile number in case we have to reach you on the day.';
  }
};

/** Payment states YouPI will not recover from; the person can start a new attempt. */
const PAYMENT_OVER = new Set(['FAILED', 'EXPIRED', 'CANCELLED', 'SUSPICIOUS']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp({ config, db, youpi, mailer = null, now = () => new Date(), log = console }) {
  const store = new Store(db);
  const uploadDir = path.join(config.dataDir, 'uploads');
  const hits = new Map();
  const staffMisses = new Map();
  // Derived from the door code, so changing STAFF_KEY signs every device out.
  const staffToken = 'ST' + crypto.createHmac('sha256', config.ticketSecret)
    .update(`staff:${config.staffKey}`).digest('hex').toUpperCase();

  const getEvent = () => store.getSetting('event', DEFAULT_EVENT);
  const getFields = () => store.getSetting('formFields', []);
  const getTheme = () => store.getSetting('theme', DEFAULT_THEME);
  const isOpen = () => store.getSetting('registrationOpen', true);

  /**
   * The door code unlocks attendee details and admin actions, so wrong guesses
   * from one address are capped; past the cap even the right code waits.
   */
  function isStaff(key, ctx) {
    if (!key) return false;
    // A signed-in device holds the session token, which is unguessable and so
    // never limited: someone guessing on the venue Wi-Fi cannot lock the door out.
    if (safeEqual(String(key).trim().toUpperCase(), staffToken)) return true;
    const t = now().getTime();
    const ip = ctx?.ip || 'unknown';
    const miss = staffMisses.get(ip);
    if (miss && miss.resetAt <= t) staffMisses.delete(ip);
    else if (miss && miss.count >= STAFF_TRIES) return false;

    if (safeEqual(String(key).trim().toUpperCase(), config.staffKey)) return true;
    const entry = staffMisses.get(ip) || { count: 0, resetAt: t + STAFF_PAUSE_MS };
    entry.count += 1;
    staffMisses.set(ip, entry);
    return false;
  }
  const forbidden = { ok: false, code: 'FORBIDDEN', error: 'That door code is not recognised. Ask the organiser for the current one.' };

  /** A few attempts per minute per address is plenty for a person and slows a script. */
  function limited(ip, max, windowMs) {
    const t = now().getTime();
    const entry = hits.get(ip);
    if (!entry || entry.resetAt <= t) {
      hits.set(ip, { count: 1, resetAt: t + windowMs });
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  }

  /* --- tickets ------------------------------------------------------------ */

  /** The QR is drawn here: the signed payload is a door pass and never goes to a third party. */
  async function ticketView(row, eventId) {
    const payload = ticketPayload(config.ticketSecret, eventId, row.ticket_id);
    return { ticketId: row.ticket_id, qrUrl: await qrDataUrl(payload) };
  }

  async function deliver(id) {
    const row = store.findRegistration(id);
    if (!row || !row.ticket_id) return;
    if (!mailer) {
      // Nothing to send; the ticket was shown on screen.
      store.setDelivery(id, true, null);
      return;
    }
    const ev = publicEvent(getEvent());
    try {
      await mailer.sendTicket({ to: row.email, name: row.name, event: ev, ...(await ticketView(row, row.event_id)) });
      store.setDelivery(id, true, null);
    } catch (err) {
      log.error(`[mail] ticket ${row.ticket_id} not sent: ${err.message}`);
      store.setDelivery(id, false, err.message);
    }
  }

  /**
   * The only door to ISSUED. `payment` is either a verified webhook body or
   * YouPI's merchant view of the session; both are trusted only as far as
   * they agree with what this server asked for.
   */
  function settle(row, payment, source) {
    const tag = `[${source}] registration ${row.id}`;

    if (payment.method !== 'UPI') {
      // A COD or counter "SUCCESS" means no money has arrived.
      log.warn(`${tag}: ignoring ${payment.method} confirmation, only UPI pays for a ticket`);
      return false;
    }
    if (baseOrderId(payment.orderId) !== row.order_id) {
      log.warn(`${tag}: order ${payment.orderId} does not belong to ${row.order_id}`);
      return false;
    }
    if (Number(payment.amountPaise) !== row.amount_paise || (payment.currency || 'INR') !== row.currency) {
      log.warn(`${tag}: paid ${payment.amountPaise} ${payment.currency}, expected ${row.amount_paise} ${row.currency}; not issuing`);
      store.markChecked(row.id, 'AMOUNT_MISMATCH', now().getTime());
      return false;
    }

    const at = istIso(now());
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const issued = store.issue(row.id, {
          ticketId: newTicketId(config.ticketPrefix),
          paymentId: payment.paymentId,
          paidAt: payment.completedAt || at,
          issuedAt: at
        });
        if (issued) {
          log.info(`${tag}: paid, ticket issued`);
          deliver(row.id).catch((err) => log.error(`[mail] ${err.message}`));
        }
        return issued;
      } catch (err) {
        // A ticket-number collision is the only constraint this can trip.
        if (!/UNIQUE/.test(err.message) || attempt === 2) throw err;
      }
    }
    return false;
  }

  /** Asks YouPI directly, for when a webhook is late or never comes. */
  async function reconcile(row, { force = false } = {}) {
    if (row.status !== 'PENDING_PAYMENT' || !row.payment_id) return;
    const t = now().getTime();
    if (!force && row.checked_at && t - row.checked_at < RECONCILE_EVERY_MS) return;
    store.markChecked(row.id, row.payment_state, t);

    let payment;
    try {
      payment = await youpi.getPayment(row.payment_id);
    } catch (err) {
      log.warn(`[poll] registration ${row.id}: ${err.message}`);
      return;
    }
    if (payment.paymentId !== row.payment_id) return;
    store.markChecked(row.id, payment.status, t);
    if (payment.status === 'SUCCESS') settle(row, payment, 'poll');
  }

  /* --- actions ------------------------------------------------------------ */

  function stats(q, ctx) {
    const staff = isStaff(q.staffKey, ctx);
    const ev = getEvent();
    const rows = store.ticketed(ev.id);
    const live = rows.filter((r) => r.status !== 'REVOKED');
    const checkedIn = live.filter((r) => r.status === 'CHECKED_IN').length;

    const counts = {
      registered: live.length,
      checkedIn,
      undelivered: live.filter((r) => !r.delivered).length,
      ticketed: live.length,
      expected: live.length - checkedIn
    };
    if (staff) counts.pending = store.countPending(ev.id);

    const out = {
      ok: true,
      event: publicEvent(ev),
      formFields: getFields(),
      theme: resolveTheme(getTheme()),
      counts,
      registration: registrationState(ev, isOpen(), now()),
      // Public on the dashboard, as before; the ticket number is staff-only.
      recent: store.recentCheckins(ev.id, 12).map((r) => ({
        name: r.name,
        ticketId: staff ? r.ticket_id : crypto.createHash('sha256').update(r.ticket_id).digest('hex').slice(0, 12),
        at: r.checkin_at
      })),
      staff,
      generatedAt: istIso(now())
    };
    if (staff) out.staffToken = staffToken;

    if (staff) {
      out.attendees = rows.map((r) => ({
        name: r.name,
        email: r.email,
        phone: r.phone,
        ticketId: r.ticket_id,
        status: r.status,
        delivered: Boolean(r.delivered),
        checkinAt: r.checkin_at,
        paidAt: r.paid_at,
        paymentId: r.payment_id,
        formAnswers: JSON.parse(r.extra || '{}')
      }));
    }
    return out;
  }

  async function register(body, ctx) {
    const ev = getEvent();
    const state = registrationState(ev, isOpen(), now());
    if (!state.open) return { ok: false, code: 'CLOSED', error: state.message };

    // Honeypot: say yes, issue nothing.
    if (body.company) return { ok: true, message: 'Thanks. Check your inbox.' };

    if (limited(ctx.ip, 12, 10 * 60 * 1000)) {
      return { ok: false, code: 'RATE_LIMITED', error: 'Too many tries from this network. Give it ten minutes.' };
    }

    const values = { name: String(body.name || ''), email: String(body.email || ''), phone: String(body.phone || '') };
    for (const field of Object.keys(RULES)) {
      const problem = RULES[field](values[field]);
      if (problem) return { ok: false, field, error: problem };
    }
    const answers = readAnswers(getFields(), body.extra);
    if (answers.error) return { ok: false, field: answers.field, error: answers.error };

    const name = values.name.trim().slice(0, 80);
    const email = values.email.trim().toLowerCase().slice(0, 120);
    const phone = values.phone.replace(/\D/g, '').slice(-13);

    if (store.hasTicketForEmail(ev.id, email)) {
      return { ok: false, field: 'email', error: 'That email already has a ticket. Check its inbox, or write to us if it never arrived.' };
    }
    const since = new Date(now().getTime() - 30 * 60 * 1000).toISOString();
    if (store.countRecentPending(ev.id, email, since) >= 5) {
      return { ok: false, field: 'email', error: 'That email has started five payments in half an hour. Finish one, or wait a bit.' };
    }

    const id = crypto.randomUUID();
    const orderId = `${config.ticketPrefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const accessToken = newSecret();
    const amountPaise = Math.round(Number(ev.amount) * 100);

    store.createRegistration({
      id, eventId: ev.id, orderId, accessToken, name, email, phone,
      extra: answers.answers, amountPaise, currency: ev.currency, createdAt: new Date(now()).toISOString()
    });

    let payment;
    try {
      payment = await youpi.createPayment({
        orderId,
        amountPaise,
        currency: ev.currency,
        customer: { name, email, mobileNumber: phone },
        metadata: { registrationId: id, eventId: ev.id },
        returnUrl: `${config.siteUrl}/?ticket=${encodeURIComponent(id)}`
      });
      if (!payment.paymentId || !/^https?:\/\//.test(String(payment.checkoutUrl || ''))) {
        throw new Error('YouPI did not return a checkout link.');
      }
    } catch (err) {
      store.deleteRegistration(id);
      log.error(`[register] could not open a payment: ${err.message}`);
      return { ok: false, code: 'PAYMENTS_DOWN', error: 'Payments are not reachable right now. Nothing was charged. Try again in a minute.' };
    }

    store.setPayment(id, payment.paymentId, payment.orderId || orderId, payment.status || 'INITIATED');
    return {
      ok: true,
      pending: true,
      ref: id,
      token: accessToken,
      checkoutUrl: payment.checkoutUrl,
      message: 'Opening the payment…'
    };
  }

  function findOwned(q) {
    const row = q.ref ? store.findRegistration(String(q.ref)) : null;
    if (!row || !safeEqual(q.token, row.access_token)) return null;
    return row;
  }

  async function ticketStatus(q) {
    let row = findOwned(q);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'We could not find that registration. It may have expired; start again.' };

    if (row.status === 'PENDING_PAYMENT') {
      await reconcile(row);
      row = store.findRegistration(row.id);
    }

    if (row.status === 'PENDING_PAYMENT') {
      const over = PAYMENT_OVER.has(row.payment_state) || row.payment_state === 'AMOUNT_MISMATCH';
      return {
        ok: true,
        status: 'PENDING',
        paymentState: row.payment_state,
        canRetry: over,
        message: row.payment_state === 'AMOUNT_MISMATCH'
          ? 'The amount that arrived did not match the ticket price. Write to us before paying again.'
          : over
            ? 'That payment did not go through. Nothing is lost if no money left your account; try again.'
            : 'Waiting for the bank to confirm your payment. This usually takes under a minute.'
      };
    }

    return {
      ok: true,
      status: row.status,
      name: row.name,
      ...(await ticketView(row, row.event_id)),
      message: row.status === 'REVOKED'
        ? 'This ticket was cancelled.'
        : mailer ? 'Payment confirmed. Your ticket is below and on its way to your inbox.' : 'Payment confirmed. Your ticket is below; screenshot it.'
    };
  }

  async function retryPayment(body) {
    let row = findOwned(body);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'We could not find that registration. Start again.' };
    if (row.status === 'PENDING_PAYMENT') {
      // Settle the current attempt first, so a payment that already went through
      // is never left behind for a fresh "-R" session.
      await reconcile(row, { force: true });
      row = store.findRegistration(row.id);
    }
    if (row.status !== 'PENDING_PAYMENT') return { ok: true, status: row.status };
    if (row.payment_state === 'AMOUNT_MISMATCH') {
      return { ok: false, code: 'NEEDS_HELP', error: 'Write to us before paying again; a payment for the wrong amount is already on file.' };
    }

    let payment;
    try {
      // The latest attempt's id: YouPI hands that session back while it is open, and
      // opens the next "-R" attempt once it is over.
      payment = await youpi.createPayment({
        orderId: row.gateway_order || row.order_id,
        amountPaise: row.amount_paise,
        currency: row.currency,
        customer: { name: row.name, email: row.email, mobileNumber: row.phone },
        metadata: { registrationId: row.id, eventId: row.event_id },
        returnUrl: `${config.siteUrl}/?ticket=${encodeURIComponent(row.id)}`
      });
    } catch (err) {
      log.error(`[retry] ${err.message}`);
      return { ok: false, code: 'PAYMENTS_DOWN', error: 'Payments are not reachable right now. Try again in a minute.' };
    }
    store.setPayment(row.id, payment.paymentId, payment.orderId || row.gateway_order, payment.status || 'INITIATED');
    if (payment.status === 'SUCCESS') {
      // The earlier attempt went through after all. This answer carries no
      // payment method, so confirm it through the merchant view like any other.
      await reconcile(store.findRegistration(row.id), { force: true });
      return { ok: true, status: store.findRegistration(row.id).status };
    }
    return { ok: true, pending: true, checkoutUrl: payment.checkoutUrl };
  }

  function checkin(body, ctx) {
    if (!isStaff(body.staffKey, ctx)) return forbidden;
    const ev = getEvent();

    let ticketId;
    if (body.payload) {
      const read = readTicketPayload(config.ticketSecret, body.payload);
      if (!read.valid) return { ok: true, state: 'INVALID', message: 'This code was not made by us.' };
      if (read.eventId !== ev.id) return { ok: true, state: 'WRONG_EVENT', ticketId: read.ticketId, message: 'This ticket is for another edition.' };
      ticketId = read.ticketId;
    } else {
      ticketId = String(body.ticketId || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
        .replace(/^([A-Z]+)([A-Z0-9]{4})([A-Z0-9]{4})$/, '$1-$2-$3');
    }

    const row = ticketId ? store.findByTicket(ev.id, ticketId) : null;
    if (!row) return { ok: true, state: 'UNKNOWN', ticketId, message: 'No ticket with that number for this edition.' };

    const who = { name: row.name, ticketId: row.ticket_id };
    if (row.status === 'REVOKED') return { ok: true, state: 'REVOKED', ...who, message: 'This ticket was cancelled.' };

    if (row.status === 'ISSUED' && store.checkIn(row.id, istIso(now()))) {
      return { ok: true, state: 'VALID', ...who, message: '' };
    }
    const fresh = store.findRegistration(row.id);
    return { ok: true, state: 'ALREADY_USED', ...who, message: fresh.checkin_at ? `Came in at ${istTime(new Date(fresh.checkin_at))}.` : '' };
  }

  function setRegistration(body, ctx) {
    if (!isStaff(body.staffKey, ctx)) return forbidden;
    store.setSetting('registrationOpen', body.open === true);
    return { ok: true, ...registrationState(getEvent(), body.open === true, now()) };
  }

  function adminConfig(q, ctx) {
    if (!isStaff(q.staffKey, ctx)) return forbidden;
    const theme = cleanTheme(getTheme());
    return {
      ok: true,
      staffToken,
      event: adminEvent(getEvent()),
      fields: getFields(),
      theme,
      themeResolved: resolveTheme(theme),
      themeOptions: THEME_OPTIONS
    };
  }

  function updateEvent(body, ctx) {
    if (!isStaff(body.staffKey, ctx)) return forbidden;
    const result = applyEventPatch(getEvent(), body.event);
    if (result.error) return { ok: false, error: result.error, field: result.field };
    store.setSetting('event', result.event);
    return { ok: true, event: adminEvent(result.event) };
  }

  function updateFormFields(body, ctx) {
    if (!isStaff(body.staffKey, ctx)) return forbidden;
    const result = cleanFormFields(body.fields);
    if (result.error) return { ok: false, error: result.error };
    store.setSetting('formFields', result.fields);
    return { ok: true, fields: result.fields };
  }

  function startNextEdition(body, ctx) {
    if (!isStaff(body.staffKey, ctx)) return forbidden;
    const current = getEvent();
    const result = applyEventPatch(current, body.event);
    if (result.error) return { ok: false, error: result.error, field: result.field };

    const next = { ...result.event, id: newEventId() };
    const registered = store.transaction(() => {
      const n = store.purgeEvent(current.id);
      store.setSetting('event', next);
      store.setSetting('registrationOpen', true);
      return n;
    });
    return { ok: true, event: adminEvent(next), purged: { registered } };
  }

  function updateTheme(body, ctx) {
    if (!isStaff(body.staffKey, ctx)) return forbidden;
    const clean = cleanTheme(body.theme);
    store.setSetting('theme', clean);
    return { ok: true, raw: clean, theme: resolveTheme(clean) };
  }

  function uploadAsset(body, ctx) {
    if (!isStaff(body.staffKey, ctx)) return forbidden;
    const asset = body.asset || {};
    const ext = UPLOAD_TYPES[asset.type];
    if (!ext) return { ok: false, error: 'PNG, JPG, WebP, GIF or SVG only.' };
    const bytes = Buffer.from(String(asset.data || ''), 'base64');
    if (!bytes.length) return { ok: false, error: 'That file arrived empty.' };
    if (bytes.length > MAX_UPLOAD_BYTES) return { ok: false, error: 'Keep it under 4 MB.' };

    fs.mkdirSync(uploadDir, { recursive: true });
    const file = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, file), bytes);
    return { ok: true, url: `${config.publicUrl}/uploads/${file}` };
  }

  const GET_ACTIONS = { stats, adminConfig, ticketStatus };
  const POST_ACTIONS = {
    register, retryPayment, checkin, registration: setRegistration, updateEvent,
    updateFormFields, startNextEdition, updateTheme, uploadAsset
  };

  /* --- webhook ------------------------------------------------------------ */

  async function webhook(req) {
    const raw = await readBody(req, MAX_WEBHOOK_BODY);
    if (!youpi.verifyWebhook(raw, req.headers['x-gateway-signature'])) {
      log.warn('[webhook] rejected: bad signature');
      return [401, { error: 'Invalid webhook signature' }];
    }

    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return [400, { error: 'Malformed JSON' }]; }

    const deliveryId = String(req.headers['x-gateway-delivery-id'] || '');
    if (deliveryId && !store.recordDelivery(deliveryId, new Date(now()).toISOString())) {
      return [200, { received: true, duplicate: true }];
    }

    try {
      const row = store.findRegistration(String(payload.metadata?.registrationId || ''));
      if (!row) {
        log.warn(`[webhook] ${payload.event} for order ${payload.orderId}: no matching registration`);
        return [200, { received: true }];
      }
      if (payload.event === 'SUCCESS') {
        settle(row, payload, 'webhook');
      } else if (row.status === 'PENDING_PAYMENT' && row.payment_id === payload.paymentId) {
        store.markChecked(row.id, payload.event, now().getTime());
      }
      return [200, { received: true }];
    } catch (err) {
      // Let YouPI retry this one.
      if (deliveryId) store.forgetDelivery(deliveryId);
      throw err;
    }
  }

  /* --- http --------------------------------------------------------------- */

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (config.allowedOrigins.includes('*')) return { 'Access-Control-Allow-Origin': '*' };
    if (origin && config.allowedOrigins.includes(origin)) return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    return {};
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    });
    res.end(JSON.stringify(body));
  }

  function serveUpload(res, name) {
    const match = /^([a-f0-9]{24})\.(png|jpg|webp|gif|svg)$/.exec(name);
    const file = match && path.join(uploadDir, name);
    if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': UPLOAD_MIME[match[2]],
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      // An uploaded SVG opened directly must not run script on this origin.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin'
    });
    fs.createReadStream(file).pipe(res);
  }

  function clientIp(req) {
    if (config.trustProxy) {
      // The proxy appends the address it saw; anything to its left is the client's to write.
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean).pop();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const cors = corsHeaders(req);

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Max-Age': '86400' });
        return res.end();
      }

      if (url.pathname === '/health') return send(res, 200, { ok: true });

      if (url.pathname === '/youpi/webhook' && req.method === 'POST') {
        const [status, body] = await webhook(req);
        return send(res, status, body);
      }

      if (url.pathname.startsWith('/uploads/') && req.method === 'GET') {
        return serveUpload(res, url.pathname.slice('/uploads/'.length));
      }

      if (url.pathname === '/api') {
        let action;
        let params;
        if (req.method === 'GET') {
          params = Object.fromEntries(url.searchParams.entries());
          action = Object.hasOwn(GET_ACTIONS, params.action) ? GET_ACTIONS[params.action] : null;
        } else if (req.method === 'POST') {
          const raw = await readBody(req, MAX_API_BODY);
          try { params = JSON.parse(raw.toString('utf8') || '{}'); } catch { params = null; }
          if (!params || typeof params !== 'object') return send(res, 400, { ok: false, code: 'BAD_JSON', error: 'Malformed request.' }, cors);
          action = Object.hasOwn(POST_ACTIONS, params.action) ? POST_ACTIONS[params.action] : null;
        }
        if (!action) {
          return send(res, 200, { ok: false, code: 'BAD_ACTION', error: 'Unknown action.' }, cors);
        }
        const result = await action(params, { ip: clientIp(req) });
        return send(res, 200, result, cors);
      }

      return send(res, 404, { error: 'Not found' }, cors);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { ok: false, error: err.message }, cors);
      log.error(`[http] ${req.method} ${url.pathname}: ${err.stack || err.message}`);
      return send(res, 500, { ok: false, code: 'ERROR', error: 'Something went wrong on our side. Try again in a moment.' }, cors);
    }
  }

  /** Hourly: forget abandoned checkouts, and keep the "wiped after the event" promise. */
  function sweep() {
    const t = now().getTime();
    for (const map of [hits, staffMisses]) {
      for (const [ip, entry] of map) if (entry.resetAt <= t) map.delete(ip);
    }
    store.purgeStalePending(new Date(t - STALE_PENDING_MS).toISOString());

    const ev = getEvent();
    if (ev.endsAt && ev.purgeAfterHours) {
      const due = new Date(ev.endsAt).getTime() + ev.purgeAfterHours * 3600 * 1000;
      if (Number.isFinite(due) && t > due) {
        const n = store.purgeEvent(ev.id);
        if (n) log.info(`[sweep] purged ${n} attendee rows for ${ev.id}`);
      }
    }
  }

  return { handle, sweep, store };
}

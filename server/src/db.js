/**
 * SQLite storage, using the sqlite module built into Node (no native build).
 *
 * One row per registration. A row is created the moment someone submits the
 * form, as PENDING_PAYMENT, and only becomes a ticket (ISSUED) when YouPI
 * confirms the money arrived.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS registrations (
    id             TEXT PRIMARY KEY,
    event_id       TEXT NOT NULL,
    order_id       TEXT NOT NULL UNIQUE,
    access_token   TEXT NOT NULL,
    name           TEXT NOT NULL,
    email          TEXT NOT NULL,
    phone          TEXT NOT NULL,
    extra          TEXT NOT NULL DEFAULT '{}',
    amount_paise   INTEGER NOT NULL CHECK (amount_paise > 0),
    currency       TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('PENDING_PAYMENT', 'ISSUED', 'CHECKED_IN', 'REVOKED')),
    payment_id     TEXT,
    gateway_order  TEXT,               -- YouPI's id for the latest attempt (order_id, or order_id-R1234)
    payment_state  TEXT,
    checked_at     INTEGER,
    ticket_id      TEXT UNIQUE,
    paid_at        TEXT,
    issued_at      TEXT,
    checkin_at     TEXT,
    delivered      INTEGER NOT NULL DEFAULT 0,
    delivery_error TEXT,
    created_at     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS registrations_event ON registrations (event_id, status);
  CREATE INDEX IF NOT EXISTS registrations_email ON registrations (event_id, email);

  -- YouPI retries a webhook until it gets a 2xx; this makes every retry a no-op.
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id          TEXT PRIMARY KEY,
    received_at TEXT NOT NULL
  );
`;

export function openDatabase(dataDir) {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'ticky.sqlite');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  getSetting(key, fallback) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  createRegistration(r) {
    this.db.prepare(`
      INSERT INTO registrations (id, event_id, order_id, access_token, name, email, phone, extra,
                                 amount_paise, currency, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_PAYMENT', ?)
    `).run(r.id, r.eventId, r.orderId, r.accessToken, r.name, r.email, r.phone,
      JSON.stringify(r.extra || {}), r.amountPaise, r.currency, r.createdAt);
  }

  deleteRegistration(id) {
    this.db.prepare("DELETE FROM registrations WHERE id = ? AND status = 'PENDING_PAYMENT'").run(id);
  }

  findRegistration(id) {
    return this.db.prepare('SELECT * FROM registrations WHERE id = ?').get(id) || null;
  }

  findByTicket(eventId, ticketId) {
    return this.db.prepare('SELECT * FROM registrations WHERE event_id = ? AND ticket_id = ?').get(eventId, ticketId) || null;
  }

  hasTicketForEmail(eventId, email) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM registrations
      WHERE event_id = ? AND email = ? AND status IN ('ISSUED', 'CHECKED_IN')
    `).get(eventId, email));
  }

  countRecentPending(eventId, email, sinceIso) {
    return this.db.prepare(`
      SELECT COUNT(*) AS n FROM registrations
      WHERE event_id = ? AND email = ? AND status = 'PENDING_PAYMENT' AND created_at >= ?
    `).get(eventId, email, sinceIso).n;
  }

  setPayment(id, paymentId, gatewayOrder, paymentState) {
    this.db.prepare("UPDATE registrations SET payment_id = ?, gateway_order = ?, payment_state = ? WHERE id = ? AND status = 'PENDING_PAYMENT'")
      .run(paymentId, gatewayOrder, paymentState, id);
  }

  markChecked(id, paymentState, atMs) {
    this.db.prepare("UPDATE registrations SET payment_state = ?, checked_at = ? WHERE id = ? AND status = 'PENDING_PAYMENT'")
      .run(paymentState, atMs, id);
  }

  /**
   * Turns a pending row into a ticket. Returns false when another delivery got
   * there first, so the caller never sends the ticket email twice.
   */
  issue(id, { ticketId, paymentId, paidAt, issuedAt }) {
    const result = this.db.prepare(`
      UPDATE registrations
      SET status = 'ISSUED', ticket_id = ?, payment_id = ?, payment_state = 'SUCCESS', paid_at = ?, issued_at = ?
      WHERE id = ? AND status = 'PENDING_PAYMENT'
    `).run(ticketId, paymentId, paidAt, issuedAt, id);
    return result.changes === 1;
  }

  setDelivery(id, delivered, error) {
    this.db.prepare('UPDATE registrations SET delivered = ?, delivery_error = ? WHERE id = ?')
      .run(delivered ? 1 : 0, error || null, id);
  }

  /** Atomic, so two phones scanning the same ticket cannot both say "Let them in". */
  checkIn(id, atIso) {
    const result = this.db.prepare("UPDATE registrations SET status = 'CHECKED_IN', checkin_at = ? WHERE id = ? AND status = 'ISSUED'")
      .run(atIso, id);
    return result.changes === 1;
  }

  ticketed(eventId) {
    return this.db.prepare(`
      SELECT * FROM registrations
      WHERE event_id = ? AND status IN ('ISSUED', 'CHECKED_IN', 'REVOKED')
      ORDER BY issued_at DESC
    `).all(eventId);
  }

  countPending(eventId) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND status = 'PENDING_PAYMENT'")
      .get(eventId).n;
  }

  recentCheckins(eventId, limit) {
    return this.db.prepare(`
      SELECT name, ticket_id, checkin_at FROM registrations
      WHERE event_id = ? AND status = 'CHECKED_IN'
      ORDER BY checkin_at DESC LIMIT ?
    `).all(eventId, limit);
  }

  /** First delivery of this id: true. A retry: false. */
  recordDelivery(deliveryId, atIso) {
    const result = this.db.prepare('INSERT OR IGNORE INTO webhook_deliveries (id, received_at) VALUES (?, ?)').run(deliveryId, atIso);
    return result.changes === 1;
  }

  forgetDelivery(deliveryId) {
    this.db.prepare('DELETE FROM webhook_deliveries WHERE id = ?').run(deliveryId);
  }

  purgeEvent(eventId) {
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND status <> 'PENDING_PAYMENT'").get(eventId);
    this.db.prepare('DELETE FROM registrations WHERE event_id = ?').run(eventId);
    return n;
  }

  /** Abandoned checkouts carry a name, email and phone; they do not get to stay. */
  purgeStalePending(beforeIso) {
    this.db.prepare("DELETE FROM registrations WHERE status = 'PENDING_PAYMENT' AND created_at < ?").run(beforeIso);
    this.db.prepare('DELETE FROM webhook_deliveries WHERE received_at < ?').run(beforeIso);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

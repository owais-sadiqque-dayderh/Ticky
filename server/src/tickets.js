/**
 * Ticket numbers and the signed payload inside the entry QR.
 *
 * The QR carries "<version>.<event>.<ticket>.<signature>". The door checks the
 * signature before it looks anything up, so a hand-made QR is "Forged" rather
 * than "Not our ticket", and a ticket from last edition is "Wrong edition".
 */
import crypto from 'node:crypto';

import QRCode from 'qrcode';

const VERSION = 't1';
// No 0/O or 1/I: these get read aloud and typed in at the door.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomChars(count) {
  const bytes = crypto.randomBytes(count);
  let out = '';
  for (let i = 0; i < count; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function newTicketId(prefix) {
  return `${prefix}-${randomChars(4)}-${randomChars(4)}`;
}

/** Long, unguessable, URL-safe. */
export function newSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url').slice(0, 22);
}

export function ticketPayload(secret, eventId, ticketId) {
  const body = `${VERSION}.${eventId}.${ticketId}`;
  return `${body}.${sign(secret, body)}`;
}

/**
 * @returns {{ valid: false } | { valid: true, eventId: string, ticketId: string }}
 */
export function readTicketPayload(secret, payload) {
  const parts = String(payload || '').trim().split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return { valid: false };

  const [version, eventId, ticketId, signature] = parts;
  const expected = sign(secret, `${version}.${eventId}.${ticketId}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false };

  return { valid: true, eventId, ticketId };
}

const QR_OPTIONS = { width: 360, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#191512', light: '#ffffff' } };

/** The entry QR as a PNG data: URL, drawn locally so the payload stays on this server. */
export function qrDataUrl(payload) {
  return QRCode.toDataURL(payload, QR_OPTIONS);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

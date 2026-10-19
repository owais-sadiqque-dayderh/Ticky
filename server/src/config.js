/**
 * Everything the server reads from the environment, read once at boot.
 *
 * Secrets live here and nowhere else: the static site never sees the door
 * code, the ticket-signing key or the YouPI webhook secret.
 */
import path from 'node:path';

function required(name, env) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing ${name}. Copy server/.env.example to server/.env and fill it in.`);
  return value;
}

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

export function loadConfig(env = process.env) {
  const ticketSecret = required('TICKET_SECRET', env);
  if (ticketSecret.length < 32) {
    throw new Error('TICKET_SECRET must be at least 32 characters. `openssl rand -hex 32` makes a good one.');
  }

  const staffKey = required('STAFF_KEY', env).toUpperCase();
  if (staffKey.length < 12) {
    throw new Error('STAFF_KEY must be at least 12 characters; it unlocks attendee details. Three short words with dashes work.');
  }
  if (/^CHANGE-?ME/.test(staffKey)) {
    throw new Error('STAFF_KEY is still a placeholder. Pick your own door code.');
  }

  return {
    port: Number(env.PORT || 8787),
    dataDir: path.resolve(env.DATA_DIR || './data'),

    /** Where this server is reachable from a browser, for uploaded background URLs. */
    publicUrl: trimSlash(required('PUBLIC_URL', env)),

    /** Where the registration page lives; YouPI sends people back here after paying. */
    siteUrl: trimSlash(required('SITE_URL', env)),

    /** Comma-separated origins allowed to call the API. Defaults to SITE_URL's origin. */
    allowedOrigins: String(env.ALLOWED_ORIGINS || new URL(required('SITE_URL', env)).origin)
      .split(',').map((o) => o.trim()).filter(Boolean),

    /** The door code typed in by staff on the scanner, dashboard and admin pages. */
    staffKey,
    ticketSecret,
    ticketPrefix: String(env.TICKET_PREFIX || 'TKY').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'TKY',

    youpi: {
      apiUrl: trimSlash(required('YOUPI_API_URL', env)),
      merchantId: required('YOUPI_MERCHANT_ID', env),
      webhookSecret: required('YOUPI_WEBHOOK_SECRET', env)
    },

    /** smtp(s)://user:pass@host:port — leave unset to show tickets on screen only. */
    smtpUrl: String(env.SMTP_URL || '').trim(),
    mailFrom: String(env.MAIL_FROM || '').trim(),

    /** Trust X-Forwarded-For for rate limiting. Only behind a proxy you run. */
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true'
  };
}

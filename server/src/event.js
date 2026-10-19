/**
 * The event's own details, the extra form questions, and whether the form is
 * taking responses. Every time is IST, whatever the server's clock zone is.
 */
import crypto from 'node:crypto';

const IST = 'Asia/Kolkata';

export const DEFAULT_EVENT = {
  id: 'ticky-01',
  edition: '01',
  name: 'Chicken Dinner',
  tagline: '',
  venue: '',
  venueLine: '',
  doorsAt: '',
  startsAt: '',
  endsAt: '',
  registrationClosesAt: '',
  amount: 100,
  currency: 'INR',
  supportEmail: '',
  purgeAfterHours: 48
};

export function newEventId() {
  return 'ticky-' + crypto.randomBytes(4).toString('hex');
}

function validDate(iso) {
  return Boolean(iso) && !Number.isNaN(new Date(iso).getTime());
}

export function istTime(date) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(date)
    .replace(/ |\s/g, ' ')
    .replace(/\s*(am|pm)/i, (_, p) => ' ' + p.toLowerCase());
}

function dayLabel(date) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short' })
    .format(date)
    .replace(',', '')
    .replace(/([A-Za-z]{3})[a-z]+$/, '$1');
}

/** "2026-10-08T21:35:00+05:30" — the offset written in, like the old backend did. */
export function istIso(date = new Date()) {
  const shifted = new Date(date.getTime() + 5.5 * 3600 * 1000);
  return shifted.toISOString().replace(/\.\d{3}Z$/, '+05:30');
}

/** What anyone may see: the registration page and the public dashboard. */
export function publicEvent(ev) {
  const starts = validDate(ev.startsAt) ? new Date(ev.startsAt) : null;
  const doors = validDate(ev.doorsAt) ? new Date(ev.doorsAt) : null;
  return {
    id: ev.id,
    edition: ev.edition,
    name: ev.name,
    tagline: ev.tagline,
    venue: ev.venue,
    venueLine: ev.venueLine,
    dateLabel: starts ? dayLabel(starts) : '',
    timeLabel: starts ? istTime(starts) : '',
    doorsLabel: doors ? istTime(doors) : '',
    startsAt: ev.startsAt,
    doorsAt: ev.doorsAt,
    amount: ev.amount,
    currency: ev.currency,
    supportEmail: ev.supportEmail
  };
}

/** What admin.html edits. */
export function adminEvent(ev) {
  return { ...ev };
}

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * Validates a patch from admin.html. Returns { event } or { error, field }.
 * Only INR: UPI cannot settle anything else.
 */
export function applyEventPatch(current, patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = { ...current };

  if ('name' in p) next.name = text(p.name, 80);
  if ('edition' in p) next.edition = text(p.edition, 8);
  if ('tagline' in p) next.tagline = text(p.tagline, 200);
  if ('venue' in p) next.venue = text(p.venue, 120);
  if ('venueLine' in p) next.venueLine = text(p.venueLine, 160);
  if ('supportEmail' in p) next.supportEmail = text(p.supportEmail, 120);

  for (const key of ['doorsAt', 'startsAt', 'endsAt', 'registrationClosesAt']) {
    if (!(key in p)) continue;
    const value = text(p[key], 40);
    if (value && !validDate(value)) return { error: `That ${key} is not a date.`, field: key };
    next[key] = value;
  }

  if ('amount' in p) {
    const amount = Number(p.amount);
    if (!Number.isInteger(amount) || amount < 1 || amount > 100000) {
      return { error: 'The ticket price has to be whole rupees, between ₹1 and ₹1,00,000.', field: 'amount' };
    }
    next.amount = amount;
  }

  if ('currency' in p) {
    const currency = text(p.currency, 3).toUpperCase() || 'INR';
    if (currency !== 'INR') return { error: 'UPI only settles in INR.', field: 'currency' };
    next.currency = currency;
  }

  if ('purgeAfterHours' in p) {
    const hours = Number(p.purgeAfterHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 90) {
      return { error: 'Purge after somewhere between 1 hour and 90 days.', field: 'purgeAfterHours' };
    }
    next.purgeAfterHours = Math.round(hours);
  }

  if (!next.name) return { error: 'The event needs a name.', field: 'name' };
  if (next.supportEmail && !/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(next.supportEmail)) {
    return { error: 'That support email does not look right.', field: 'supportEmail' };
  }
  return { event: next };
}

/* --- extra form questions ------------------------------------------------ */

const FIELD_TYPES = ['text', 'textarea', 'select', 'multiselect', 'checkbox'];

function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'question';
}

export function cleanFormFields(raw) {
  if (!Array.isArray(raw)) return { error: 'Questions arrive as a list.' };
  if (raw.length > 20) return { error: 'Twenty questions is plenty.' };

  const seen = new Set();
  const fields = [];
  for (const f of raw) {
    const label = text(f && f.label, 120);
    if (!label) continue;
    const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
    const options = (Array.isArray(f.options) ? f.options : String(f.options || '').split(','))
      .map((o) => text(o, 80)).filter(Boolean).slice(0, 30);
    if ((type === 'select' || type === 'multiselect') && !options.length) {
      return { error: `"${label}" needs at least one option.` };
    }

    let key = slug(label);
    for (let i = 2; seen.has(key); i++) key = `${slug(label)}_${i}`;
    seen.add(key);

    fields.push({ key, label, type, required: Boolean(f.required), options: type === 'select' || type === 'multiselect' ? options : [] });
  }
  return { fields };
}

/** Mirrors validateCustomField() in register.js so both say the same thing. */
export function readAnswers(fields, extra) {
  const input = extra && typeof extra === 'object' ? extra : {};
  const answers = {};
  for (const f of fields) {
    const raw = input[f.key];
    if (f.type === 'checkbox') {
      if (f.required && raw !== true) return { error: `${f.label} is required.`, field: 'extra_' + f.key };
      answers[f.key] = raw === true;
    } else if (f.type === 'multiselect') {
      const picked = (Array.isArray(raw) ? raw : []).filter((v) => f.options.includes(v));
      if (f.required && !picked.length) return { error: `${f.label} is required.`, field: 'extra_' + f.key };
      answers[f.key] = picked;
    } else {
      const value = text(raw, 1000);
      if (f.required && !value) return { error: `${f.label} is required.`, field: 'extra_' + f.key };
      if (f.type === 'select' && value && !f.options.includes(value)) {
        return { error: `${f.label}: choose one of the listed options.`, field: 'extra_' + f.key };
      }
      if (value) answers[f.key] = value;
    }
  }
  return { answers };
}

/* --- open / closed ------------------------------------------------------- */

export function registrationState(ev, isOpen, now = new Date()) {
  const closesAt = validDate(ev.registrationClosesAt) ? ev.registrationClosesAt : '';
  const contact = ev.supportEmail ? ` Write to ${ev.supportEmail} if you still want to come.` : '';

  if (!isOpen) {
    return { open: false, reason: 'closed', message: 'Registration is closed.' + contact };
  }
  if (closesAt && new Date(closesAt) <= now) {
    return { open: false, reason: 'deadline', closesAt, message: 'Registration closed at the deadline.' + contact };
  }
  return { open: true, closesAt: closesAt || null };
}

/**
 * Deployment configuration. This is the only file you edit after deploying the
 * Ticky server (server/README.md).
 *
 * Nothing secret goes here — it ships to every browser. The door code is typed
 * in by staff on the scanner page, not stored in this file.
 */
window.OSDAYS_CONFIG = {
  /** The Ticky server's /api URL, e.g. https://api.example.com/api */
  API_BASE: 'PASTE_TICKY_SERVER_URL/api',

  /**
   * Shown while the first /stats request is still in flight, so the page never
   * renders empty. The server's copy always wins once it arrives.
   */
  FALLBACK_EVENT: {
    edition: '01',
    name: 'Chicken Dinner',
    tagline: 'No chickens were harmed in the making of this form... but dinner is a different story.',
    venue: 'North Campus',
    venueLine: 'Oak, North Campus',
    dateLabel: 'Tue 29 Sep',
    timeLabel: '9:30 pm',
    doorsLabel: '9:20 pm',
    amount: 100,
    currency: 'INR',
    supportEmail: 'dayderhowaissadiqque@gmail.com'
  },

  /** Dashboard refresh interval, milliseconds. */
  POLL_MS: 12000
};

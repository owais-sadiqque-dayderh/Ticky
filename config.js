/**
 * Deployment configuration. This is the only file you edit after deploying the
 * Apps Script Web App.
 *
 * Nothing secret goes here — it ships to every browser. The door code is typed
 * in by staff on the scanner page, not stored in this file.
 */
window.OSDAYS_CONFIG = {
  /** The Apps Script Web App /exec URL. Run setupProject(), deploy, paste here. */
  API_BASE: 'https://script.google.com/macros/s/AKfycbzEXCajdx4Ri-vlhPH4KwktRXO6mEfLZj2IPrJAbJ0X_EDOVMAjF2UlM8FQ7uuebD9B5g/exec',

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
    upiVpa: 'dayderhowaissadiqque@okaxis',
    upiPayeeName: 'Owais Sadiqque',
    payQrImageUrl: '',
    supportEmail: 'dayderhowaissadiqque@gmail.com'
  },

  /** Dashboard refresh interval, milliseconds. */
  POLL_MS: 12000
};

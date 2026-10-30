/**
 * Thin client for the Apps Script Web App.
 *
 * Apps Script cannot answer a CORS preflight, so every POST goes out as a
 * "simple request": Content-Type text/plain carrying a JSON string. The server
 * parses e.postData.contents either way.
 */
(function (global) {
  var CFG = global.OSDAYS_CONFIG || {};

  function base() {
    var url = CFG.API_BASE || '';
    if (!url || url.indexOf('PASTE_') === 0) {
      throw new ApiError(
        'This page is not connected to a backend yet. Paste the Apps Script Web App URL into web/config.js.',
        'NOT_CONFIGURED'
      );
    }
    return url;
  }

  function ApiError(message, code) {
    this.name = 'ApiError';
    this.message = message;
    this.code = code || 'ERROR';
  }
  ApiError.prototype = Object.create(Error.prototype);

  function toQuery(params) {
    return Object.keys(params || {})
      .filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');
  }

  async function read(response) {
    if (!response.ok) {
      throw new ApiError('The server answered with ' + response.status + '. Try again in a moment.', 'HTTP_' + response.status);
    }
    var text = await response.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      // Almost always the Google sign-in interstitial: the deployment is not
      // set to "Anyone", so an anonymous browser gets an HTML login page.
      throw new ApiError(
        'The backend replied with a sign-in page. Redeploy the Web App with access set to "Anyone".',
        'NOT_PUBLIC'
      );
    }
  }

  async function post(payload) {
    var response;
    try {
      response = await fetch(base(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow'
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError('No connection. Check the network and try again.', 'OFFLINE');
    }
    return read(response);
  }

  async function get(params) {
    var response;
    try {
      response = await fetch(base() + '?' + toQuery(params), { method: 'GET', redirect: 'follow' });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError('No connection. Check the network and try again.', 'OFFLINE');
    }
    return read(response);
  }

  global.API = {
    ApiError: ApiError,
    config: CFG,

    register: function (form) {
      return post({
        action: 'register',
        name: form.name,
        email: form.email,
        phone: form.phone,
        amount: form.amount,
        proof: form.proof,       // { type, data } — base64, no multipart to preflight
        company: form.company,   // honeypot; always empty for a real person
        extra: form.extra        // answers to this event's custom questions, if any
      });
    },

    checkin: function (payload, staffKey) {
      return post({ action: 'checkin', payload: payload, staffKey: staffKey });
    },

    checkinByNumber: function (ticketId, staffKey) {
      return post({ action: 'checkin', ticketId: ticketId, staffKey: staffKey });
    },

    stats: function (staffKey) {
      return get({ action: 'stats', staffKey: staffKey });
    },

    /** Staff switch: stop or resume taking responses on the public form. */
    setRegistration: function (open, staffKey) {
      return post({ action: 'registration', open: open === true, staffKey: staffKey });
    },

    /** Staff only: the full event config and field schema, for admin.html. */
    adminConfig: function (staffKey) {
      return get({ action: 'adminConfig', staffKey: staffKey });
    },

    /** Staff only: patch the event's own details. */
    updateEvent: function (patch, staffKey) {
      return post({ action: 'updateEvent', event: patch, staffKey: staffKey });
    },

    /** Staff only: replace the extra-question schema wholesale. */
    updateFormFields: function (fields, staffKey) {
      return post({ action: 'updateFormFields', fields: fields, staffKey: staffKey });
    },

    /** Staff only: purge the outgoing event and (optionally) apply the next one's details. */
    startNextEdition: function (patch, staffKey) {
      return post({ action: 'startNextEdition', event: patch, staffKey: staffKey });
    },

    /** Staff only: replace colours, fonts and backgrounds. */
    updateTheme: function (theme, staffKey) {
      return post({ action: 'updateTheme', theme: theme, staffKey: staffKey });
    },

    /** Staff only: upload a resized background image; returns a public URL. */
    uploadAsset: function (asset, staffKey) {
      return post({ action: 'uploadAsset', asset: asset, staffKey: staffKey });
    }
  };

  /* --- shared formatting ------------------------------------------------- */

  global.fmt = {
    money: function (amount, currency) {
      var n = Number(amount || 0);
      var symbol = currency === 'INR' || !currency ? '₹' : currency + ' ';
      return symbol + (n % 1 === 0 ? n.toFixed(0) : n.toFixed(2));
    },

    /**
     * Every time in this system is Indian Standard Time, including on a laptop
     * that is set to something else. The backend writes the offset into the
     * timestamp; this converts it rather than reading the digits and hoping.
     */
    clockTime: function (iso) {
      if (!iso) return '';
      var when = new Date(iso);
      if (isNaN(when.getTime())) return '';
      return fmt.istTime(when);
    },

    /**
     * "Sat 12 Sep, 3:00 pm" — a deadline, in the timezone it applies in.
     * en-GB's short month for September is "Sept", four letters against
     * everything else's three; trimmed so it never stands out as the odd one.
     */
    dayLabel: function (iso) {
      var when = new Date(iso);
      if (!iso || isNaN(when.getTime())) return '';
      try {
        var day = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short'
        }).format(when).replace(/([A-Za-z]{3})[a-z]+$/, '$1');
        return day + ', ' + fmt.istTime(when);
      } catch (err) {
        return '';
      }
    },

    /** The wall clock at the venue, whatever the phone showing it is set to. */
    istTime: function (date) {
      try {
        return new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Kolkata',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        }).format(date || new Date())
          .replace(/ /g, ' ')
          .replace(/\s*(am|pm)/i, function (_, period) { return ' ' + period.toLowerCase(); });
      } catch (err) {
        return '';
      }
    },

    /**
     * UPI deep link. Opening this on a phone hands the payee and the exact
     * amount straight to GPay/PhonePe/Paytm, which is what stops the
     * amount-mismatch problem at its source.
     */
    upiLink: function (ev, note) {
      var params = [
        'pa=' + encodeURIComponent(ev.upiVpa),
        'pn=' + encodeURIComponent(ev.upiPayeeName),
        'am=' + encodeURIComponent(Number(ev.amount).toFixed(2)),
        'cu=' + encodeURIComponent(ev.currency || 'INR'),
        'tn=' + encodeURIComponent(note || (ev.name + ' ' + ev.edition))
      ];
      return 'upi://pay?' + params.join('&');
    }
  };
})(window);

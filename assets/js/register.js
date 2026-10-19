/* Registration page behaviour. */
(function () {
  'use strict';

  var CFG = window.OSDAYS_CONFIG || {};
  var form = document.getElementById('register-form');
  var statusBox = document.getElementById('form-status');
  var submitBtn = document.getElementById('submit');
  var preview = document.getElementById('ticket-preview');
  var previewName = document.getElementById('ticket-name');
  var previewStatus = document.getElementById('ticket-status');
  var closedPanel = document.getElementById('closed');
  var regStatus = document.getElementById('reg-status');
  var regStatusText = document.getElementById('reg-status-text');

  var event = Object.assign({}, CFG.FALLBACK_EVENT);
  var customFields = [];
  var customFieldsBox = document.getElementById('custom-fields');

  /* --- hydrate ----------------------------------------------------------- */

  function bind(values) {
    Object.keys(values).forEach(function (key) {
      document.querySelectorAll('[data-bind="' + key + '"]').forEach(function (el) {
        if (values[key] === undefined || values[key] === null || values[key] === '') return;
        el.textContent = values[key];
      });
    });
  }

  function render() {
    bind({
      edition: event.edition,
      name: event.name,
      tagline: event.tagline,
      dateLabel: event.dateLabel,
      timeLabel: event.timeLabel,
      doorsLabel: event.doorsLabel,
      venueLine: event.venueLine,
      amountLabel: fmt.money(event.amount, event.currency),
      supportEmail: event.supportEmail
    });

    document.title = 'Get a ticket — ' + event.name;

    var support = document.getElementById('support-link');
    if (support && event.supportEmail) support.href = 'mailto:' + event.supportEmail;
  }

  /**
   * Whether the form is taking responses. There is no headcount and no seat
   * count — the only thing anyone needs to know is open or closed, and a closed
   * form says so instead of letting someone fill it in and then refusing them.
   */
  function renderRegistration(state) {
    if (!state) return;

    if (state.open) {
      regStatus.setAttribute('data-state', 'open');
      regStatusText.textContent = state.closesAt
        ? 'Registration open until ' + fmt.dayLabel(state.closesAt)
        : 'Registration open';
      return;
    }

    regStatus.setAttribute('data-state', 'closed');
    regStatusText.textContent = 'Registration closed';
    closeForm(state.message);
  }

  function closeForm(message) {
    // Someone who paid before the form closed still gets to see their ticket.
    if (loadPending()) return;
    form.hidden = true;
    closedPanel.hidden = false;
    document.getElementById('closed-note').textContent =
      message || 'This form is no longer taking responses.';

    // A blank ticket beside a closed form is a picture of something that is not
    // going to happen. It goes with the form.
    var panel = document.querySelector('.preview');
    if (panel && preview.getAttribute('data-state') !== 'issued') panel.hidden = true;
  }

  /**
   * Extra questions the organiser configured in admin.html, beyond the fixed
   * name/email/phone. Rendered once, from whatever ?action=stats returns —
   * this page does not poll, so the schema is fixed for the life of the tab.
   */
  function renderCustomFields(fields) {
    customFields = Array.isArray(fields) ? fields : [];
    customFieldsBox.innerHTML = '';

    customFields.forEach(function (f) {
      var name = 'extra_' + f.key;

      if (f.type === 'checkbox') {
        var checkWrap = document.createElement('label');
        checkWrap.className = 'field field--checkbox';
        var check = document.createElement('input');
        check.type = 'checkbox';
        check.name = name;
        var checkLabel = document.createElement('span');
        checkLabel.className = 'label';
        checkLabel.textContent = f.label;
        checkWrap.appendChild(check);
        checkWrap.appendChild(checkLabel);
        customFieldsBox.appendChild(checkWrap);
        wireCustomField(f, check);
        return;
      }

      if (f.type === 'multiselect') {
        var group = document.createElement('fieldset');
        group.className = 'field field--group';
        var legend = document.createElement('legend');
        legend.className = 'label';
        legend.textContent = f.label + (f.required ? '' : ' (optional)');
        group.appendChild(legend);

        var boxes = f.options.map(function (opt) {
          var optWrap = document.createElement('label');
          optWrap.className = 'field--group-option';
          var box = document.createElement('input');
          box.type = 'checkbox';
          box.name = name;
          box.value = opt;
          var optLabel = document.createElement('span');
          optLabel.textContent = opt;
          optWrap.appendChild(box);
          optWrap.appendChild(optLabel);
          group.appendChild(optWrap);
          return box;
        });

        var groupError = document.createElement('span');
        groupError.className = 'field-error';
        groupError.setAttribute('data-error-for', name);
        groupError.setAttribute('role', 'alert');
        group.appendChild(groupError);

        customFieldsBox.appendChild(group);
        wireMultiselectField(f, boxes);
        return;
      }

      var wrap = document.createElement('label');
      wrap.className = 'field';
      var label = document.createElement('span');
      label.className = 'label';
      label.textContent = f.label + (f.required ? '' : ' (optional)');
      wrap.appendChild(label);

      var control;
      if (f.type === 'select') {
        control = document.createElement('select');
        var blank = document.createElement('option');
        blank.value = '';
        blank.textContent = 'Choose one';
        control.appendChild(blank);
        f.options.forEach(function (opt) {
          var o = document.createElement('option');
          o.value = opt;
          o.textContent = opt;
          control.appendChild(o);
        });
      } else if (f.type === 'textarea') {
        control = document.createElement('textarea');
        control.rows = 3;
      } else {
        control = document.createElement('input');
        control.type = 'text';
      }
      control.name = name;
      wrap.appendChild(control);

      var error = document.createElement('span');
      error.className = 'field-error';
      error.setAttribute('data-error-for', name);
      error.setAttribute('role', 'alert');
      wrap.appendChild(error);

      customFieldsBox.appendChild(wrap);
      wireCustomField(f, control);
    });
  }

  function validateCustomField(f, rawValue) {
    if (f.type === 'multiselect') {
      return f.required && (!Array.isArray(rawValue) || !rawValue.length)
        ? f.label + ' is required.' : null;
    }
    if (f.required && (f.type === 'checkbox' ? !rawValue : !String(rawValue || '').trim())) {
      return f.label + ' is required.';
    }
    if (f.type === 'select' && rawValue && f.options.indexOf(rawValue) < 0) {
      return f.label + ': choose one of the listed options.';
    }
    return null;
  }

  function wireCustomField(f, input) {
    var name = 'extra_' + f.key;
    var read = function () { return f.type === 'checkbox' ? input.checked : input.value; };
    input.addEventListener('blur', function () { showFieldError(name, validateCustomField(f, read())); });
    input.addEventListener('input', function () {
      var wrapper = input.closest('.field');
      if (wrapper && wrapper.getAttribute('data-invalid') === 'true') {
        showFieldError(name, validateCustomField(f, read()));
      }
    });
  }

  function wireMultiselectField(f, boxes) {
    var name = 'extra_' + f.key;
    var read = function () {
      return boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    };
    boxes.forEach(function (box) {
      box.addEventListener('change', function () { showFieldError(name, validateCustomField(f, read())); });
    });
  }

  function collectCustomValues() {
    var values = {};
    customFields.forEach(function (f) {
      if (f.type === 'multiselect') {
        var boxes = Array.prototype.filter.call(
          customFieldsBox.querySelectorAll('input[name="extra_' + f.key + '"]'),
          function (b) { return b.checked; }
        );
        values[f.key] = boxes.map(function (b) { return b.value; });
        return;
      }
      var input = form.elements['extra_' + f.key];
      if (input) values[f.key] = f.type === 'checkbox' ? input.checked : input.value;
    });
    return values;
  }

  async function loadEvent() {
    try {
      var data = await API.stats();
      if (data && data.ok) {
        event = Object.assign(event, data.event);
        render();
        renderCustomFields(data.formFields);
        renderRegistration(data.registration);
        if (data.theme) Theme.apply(data.theme, 'register');
      }
    } catch (err) {
      // The page is fully usable on fallback data; only the live state is lost.
      regStatus.setAttribute('data-state', 'loading');
      regStatusText.textContent =
        err.code === 'NOT_CONFIGURED' ? 'Backend not connected yet' : 'Checking registration…';
      console.warn(err.message);
    }
  }

  /* --- reveal -------------------------------------------------------------- */

  if ('IntersectionObserver' in window) {
    var seen = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.setAttribute('data-reveal', 'in');
        seen.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -12% 0px' });
    document.querySelectorAll('[data-reveal]').forEach(function (el) { seen.observe(el); });
  } else {
    document.querySelectorAll('[data-reveal]').forEach(function (el) {
      el.setAttribute('data-reveal', 'in');
    });
  }

  /* --- live ticket preview ------------------------------------------------ */

  form.elements.name.addEventListener('input', function (e) {
    var value = e.target.value.trim();
    previewName.textContent = value || 'Your name';
    previewName.setAttribute('data-empty', value ? 'false' : 'true');
  });

  /* --- validation --------------------------------------------------------- */
  /* Same rules as the server, phrased the same way, so nobody is told two
     different things about the same field. */

  var RULES = {
    name: function (v) {
      return v.trim().length >= 2 ? null : 'Tell us the name that should appear on the ticket.';
    },
    email: function (v) {
      return /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(v.trim())
        ? null : 'That email will not receive the ticket. Check it once more.';
    },
    phone: function (v) {
      var digits = v.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 13
        ? null : 'We need a 10-digit mobile number in case we have to reach you on the day.';
    }
  };

  // A group of same-named checkboxes (a multiselect question) resolves through
  // form.elements as a RadioNodeList rather than one element; these two only
  // ever need the first one to find the wrapper or take focus.
  function fieldElement(fieldName) {
    var input = form.elements[fieldName];
    if (!input) return null;
    return input.nodeType ? input : input[0];
  }

  function showFieldError(fieldName, message) {
    var input = fieldElement(fieldName);
    if (!input) return;
    var wrapper = input.closest('.field');
    var slot = form.querySelector('[data-error-for="' + fieldName + '"]');
    if (wrapper) wrapper.setAttribute('data-invalid', message ? 'true' : 'false');
    if (slot) slot.textContent = message || '';
  }

  function focusField(fieldName) {
    var input = fieldElement(fieldName);
    if (!input) return;
    input.focus();
  }

  Object.keys(RULES).forEach(function (fieldName) {
    var input = form.elements[fieldName];
    if (!input) return;
    input.addEventListener('blur', function () {
      if (input.value.trim()) showFieldError(fieldName, RULES[fieldName](input.value));
    });
    input.addEventListener('input', function () {
      if (input.closest('.field').getAttribute('data-invalid') === 'true') {
        showFieldError(fieldName, RULES[fieldName](input.value));
      }
    });
  });

  /* --- submit ------------------------------------------------------------- */

  function setStatus(tone, title, detail) {
    statusBox.setAttribute('data-tone', tone);
    statusBox.innerHTML = '';
    if (title) {
      var strong = document.createElement('strong');
      strong.textContent = title;
      statusBox.appendChild(strong);
    }
    statusBox.appendChild(document.createTextNode(detail || ''));
  }

  /* --- paying ---------------------------------------------------------------
     The form opens a payment on the server and sends this tab to YouPI's
     checkout. YouPI sends it back here; from then on this page only asks the
     server whether the bank has confirmed it. Nothing the browser says counts
     as paid. The ref and token live in localStorage so a reload, or the trip
     out to a UPI app and back, picks up where it left off. */

  var PENDING_STORE = 'ticky.pending';
  var POLL_MS = 3000;
  var POLL_FOR_MS = 15 * 60 * 1000;
  var payWait = document.getElementById('pay-wait');
  var retryBtn = document.getElementById('pay-retry');
  var pollTimer = null;

  function savePending(p) { localStorage.setItem(PENDING_STORE, JSON.stringify(p)); }
  function loadPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_STORE) || 'null'); } catch (err) { return null; }
  }
  function clearPending() { localStorage.removeItem(PENDING_STORE); }

  function lockForm(locked) {
    form.querySelectorAll('input, select, textarea').forEach(function (input) { input.disabled = locked; });
  }

  function resetSubmit() {
    submitBtn.disabled = false;
    submitBtn.hidden = false;
    submitBtn.textContent = 'Pay and get my ticket';
  }

  function goPay(checkoutUrl) {
    submitBtn.textContent = 'Opening the payment…';
    window.location.assign(checkoutUrl);
  }

  function showWaiting(pending, status) {
    clearTimeout(pollTimer);
    lockForm(true);
    submitBtn.hidden = true;
    payWait.hidden = false;
    // YouPI hands back the session that is still open, or a fresh one once the
    // last attempt is over, so one button covers "I closed it" and "it failed".
    retryBtn.hidden = false;
    retryBtn.textContent = status && status.canRetry ? 'Try paying again' : 'Back to the payment';
    previewName.textContent = pending.name || previewName.textContent;
    previewName.setAttribute('data-empty', 'false');
    previewStatus.textContent = status && status.canRetry ? 'Not paid yet' : 'Waiting for the bank';
    setStatus(status && status.canRetry ? 'error' : '', '', (status && status.message) || 'Checking your payment…');
  }

  async function checkPayment(pending) {
    var status;
    try {
      status = await API.ticketStatus(pending.ref, pending.token);
    } catch (err) {
      status = { ok: true, status: 'PENDING', message: 'Reconnecting… ' + err.message };
    }

    if (!status.ok) {
      clearPending();
      lockForm(false);
      payWait.hidden = true;
      resetSubmit();
      setStatus('error', 'Not found', status.error);
      return;
    }

    if (status.status === 'PENDING') {
      showWaiting(pending, status);
      if (!status.canRetry && Date.now() - pending.startedAt < POLL_FOR_MS) {
        pollTimer = setTimeout(function () { checkPayment(pending); }, POLL_MS);
      } else if (!status.canRetry) {
        setStatus('error', 'Still not confirmed. ', 'If money left your account, write to us with the time you paid; otherwise try again.');
      }
      return;
    }

    onIssued(status, pending.name);
  }

  retryBtn.addEventListener('click', async function () {
    var pending = loadPending();
    if (!pending) return;
    retryBtn.disabled = true;
    try {
      var result = await API.retryPayment(pending.ref, pending.token);
      if (!result.ok) {
        setStatus('error', '', result.error);
        return;
      }
      if (result.checkoutUrl) {
        pending.startedAt = Date.now();
        savePending(pending);
        goPay(result.checkoutUrl);
        return;
      }
      checkPayment(pending);
    } catch (err) {
      setStatus('error', 'Could not reach the server', err.message);
    } finally {
      retryBtn.disabled = false;
    }
  });

  document.getElementById('pay-reset').addEventListener('click', function () {
    if (!window.confirm('Start over? If you already paid, wait here instead — the ticket will turn up.')) return;
    clearTimeout(pollTimer);
    clearPending();
    window.location.replace(window.location.pathname);
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();

    var values = {
      name: form.elements.name.value,
      email: form.elements.email.value,
      phone: form.elements.phone.value,
      company: form.elements.company.value,
      extra: collectCustomValues()
    };

    var firstBad = null;
    Object.keys(RULES).forEach(function (fieldName) {
      var message = RULES[fieldName](values[fieldName] || '');
      showFieldError(fieldName, message);
      if (message && !firstBad) firstBad = fieldName;
    });

    customFields.forEach(function (f) {
      var message = validateCustomField(f, values.extra[f.key]);
      showFieldError('extra_' + f.key, message);
      if (message && !firstBad) firstBad = 'extra_' + f.key;
    });

    if (firstBad) {
      focusField(firstBad);
      setStatus('error', 'Not sent yet', 'Fix the highlighted field and try again.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    setStatus('', '', '');

    try {
      var result = await API.register(values);

      if (!result.ok) {
        // Registration was closed while this form sat open in a tab.
        if (result.code === 'CLOSED') {
          regStatus.setAttribute('data-state', 'closed');
          regStatusText.textContent = 'Registration closed';
          closeForm(result.error);
          return;
        }
        if (result.field) {
          showFieldError(result.field, result.error);
          focusField(result.field);
        }
        setStatus('error', 'Not sent yet', result.error);
        resetSubmit();
        return;
      }

      // The honeypot answers "ok" with nothing to pay for, to tell a bot
      // nothing. A password manager filling that hidden field would land a
      // real person here, so show them the message.
      if (!result.checkoutUrl) {
        setStatus('ok', '', result.message);
        resetSubmit();
        return;
      }

      savePending({ ref: result.ref, token: result.token, name: values.name.trim(), startedAt: Date.now() });
      goPay(result.checkoutUrl);
    } catch (err) {
      setStatus('error', 'Could not reach the server', err.message);
      resetSubmit();
    }
  });

  /**
   * The ticket exists by the time this runs, so the preview stops being a
   * preview: the real QR goes in, and this screen is enough to get through the
   * door even if the email never arrives.
   */
  function onIssued(result, name) {
    clearTimeout(pollTimer);
    payWait.hidden = true;
    submitBtn.hidden = false;
    submitBtn.disabled = true;
    submitBtn.textContent = 'You are in';
    submitBtn.setAttribute('data-done', 'true');
    setStatus('ok', '', result.message);
    lockForm(true);

    preview.setAttribute('data-state', 'issued');
    previewName.textContent = result.name || name;
    previewName.setAttribute('data-empty', 'false');
    document.getElementById('ticket-id').textContent = result.ticketId;

    var slot = document.getElementById('ticket-qr');
    slot.innerHTML = '';
    var qr = document.createElement('img');
    qr.alt = 'Your entry QR code';
    qr.width = 160;
    qr.height = 160;
    qr.src = result.qrUrl;
    slot.appendChild(qr);

    previewStatus.textContent = 'Screenshot this, or check your inbox';
    document.querySelector('.preview').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /** Back from YouPI, or reloaded mid-payment: carry on waiting. */
  function resume() {
    var pending = loadPending();
    var params = new URLSearchParams(window.location.search);
    if (!pending || (params.get('ticket') && params.get('ticket') !== pending.ref)) return false;
    // A returning tab gets a fresh window to wait in.
    pending.startedAt = Date.now();
    savePending(pending);
    showWaiting(pending, null);
    checkPayment(pending);
    return true;
  }

  render();
  loadEvent();
  resume();
})();

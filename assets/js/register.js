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
      upiVpa: event.upiVpa,
      supportEmail: event.supportEmail
    });

    document.title = 'Get a ticket — ' + event.name;

    var support = document.getElementById('support-link');
    if (support && event.supportEmail) support.href = 'mailto:' + event.supportEmail;

    var deepLink = fmt.upiLink(event, event.name + ' ' + event.edition + ' ticket');

    // The QR encodes this same deep link, so scanning it hands the payee and
    // exact amount straight to whatever UPI app reads it. A hosted GPay QR
    // image is used instead when one is configured.
    var qr = document.getElementById('pay-qr');
    qr.src = event.payQrImageUrl
      || 'https://quickchart.io/qr?size=360&margin=1&ecLevel=M&dark=191512&light=ffffff&text=' + encodeURIComponent(deepLink);
    qr.alt = 'UPI QR code to pay ' + fmt.money(event.amount, event.currency) + ' to ' + event.upiPayeeName;
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
    // The file input is clipped rather than hidden, so it still takes focus and
    // .drop:focus-within draws the ring around the box standing in for it.
    if (input.type === 'file') input.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  /* --- the payment screenshot --------------------------------------------- */

  var MAX_BYTES = 6 * 1024 * 1024;
  var MAX_EDGE = 1600;   // more than enough to read a payment screen
  var TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'application/pdf'];

  var proofInput = form.elements.proof;
  var dropZone = document.getElementById('proof-drop');
  var proofThumb = document.getElementById('proof-thumb');
  var proof = null;   // { type, data } once a file has been read

  function describeSize(bytes) {
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
  }

  function setDropState(state, kind, text, meta) {
    dropZone.setAttribute('data-state', state);
    dropZone.setAttribute('data-kind', kind || 'image');
    document.getElementById('proof-text').textContent = text;
    document.getElementById('proof-meta').textContent = meta;
  }

  function clearProof(message) {
    proof = null;
    proofInput.value = '';
    proofThumb.hidden = true;
    proofThumb.removeAttribute('src');
    setDropState('empty', 'image', 'Add the screenshot', 'PNG, JPG or PDF');
    showFieldError('proof', message || '');
  }

  /**
   * Shrink a photo to something worth uploading over a venue's wifi. Anything we
   * cannot draw — a PDF, a HEIC the browser will not decode — is sent as-is;
   * only the size limit applies then.
   */
  function shrinkImage(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve({ data: canvas.toDataURL('image/jpeg', 0.82), type: 'image/jpeg', preview: canvas.toDataURL('image/jpeg', 0.5) });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('That file could not be read. Try picking it again.')); };
      reader.readAsDataURL(file);
    });
  }

  proofInput.addEventListener('change', async function () {
    var file = proofInput.files && proofInput.files[0];
    if (!file) return clearProof('');

    if (TYPES.indexOf(file.type) < 0 && !/^image\//.test(file.type)) {
      return clearProof('A screenshot or a PDF works. That one is a ' + (file.type || 'kind we cannot read') + '.');
    }

    setDropState('empty', 'image', 'Reading…', file.name);

    try {
      var shrunk = /^image\//.test(file.type) ? await shrinkImage(file) : null;
      var dataUrl = shrunk ? shrunk.data : await readAsDataUrl(file);
      var base64 = String(dataUrl).replace(/^data:[^,]*,/, '');
      var bytes = Math.floor(base64.replace(/=+$/, '').length * 3 / 4);

      if (bytes > MAX_BYTES) {
        return clearProof('That file is ' + describeSize(bytes) + '. Anything under 6 MB is fine.');
      }

      proof = { type: shrunk ? shrunk.type : file.type, data: base64 };

      if (shrunk) {
        proofThumb.src = shrunk.preview;
        proofThumb.hidden = false;
        setDropState('filled', 'image', 'Screenshot added', describeSize(bytes) + ' · tap to change');
      } else {
        proofThumb.hidden = true;
        setDropState('filled', 'file', file.name, describeSize(bytes) + ' · tap to change');
      }
      showFieldError('proof', '');
    } catch (err) {
      clearProof(err.message);
    }
  });

  /* --- copy the VPA ------------------------------------------------------- */

  document.getElementById('copy-vpa').addEventListener('click', async function (e) {
    var btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(event.upiVpa);
      var original = btn.textContent;
      btn.setAttribute('data-copied', 'true');
      btn.textContent = 'Copied';
      setTimeout(function () {
        btn.removeAttribute('data-copied');
        btn.textContent = original;
      }, 1600);
    } catch (err) {
      // Clipboard blocked: selecting the text does the same job.
      var range = document.createRange();
      range.selectNodeContents(btn);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
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

  form.addEventListener('submit', async function (e) {
    e.preventDefault();

    var values = {
      name: form.elements.name.value,
      email: form.elements.email.value,
      phone: form.elements.phone.value,
      company: form.elements.company.value,
      amount: event.amount,
      proof: proof,
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

    if (!proof) {
      showFieldError('proof', 'Add the payment screenshot — it is the only record either of us keeps.');
      if (!firstBad) firstBad = 'proof';
    }

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
        submitBtn.disabled = false;
        submitBtn.textContent = 'Get my ticket';
        return;
      }

      onIssued(result, values);
    } catch (err) {
      setStatus('error', 'Could not reach the server', err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Get my ticket';
    }
  });

  /**
   * The ticket exists by the time this runs, so the preview stops being a
   * preview: the real QR goes in, and this screen is enough to get through the
   * door even if the email never arrives.
   */
  function onIssued(result, values) {
    // The button carries the confirmation; the panel carries the detail. Saying
    // the same thing in both places would make one of them noise.
    submitBtn.textContent = 'You are in';
    submitBtn.setAttribute('data-done', 'true');
    setStatus('ok', '', result.message);

    // The honeypot answers "ok" without a ticket, to tell a bot nothing. A
    // password manager filling that hidden field would land a real person here,
    // so show them the message rather than a ticket full of undefined.
    if (!result.ticketId) return;

    preview.setAttribute('data-state', 'issued');
    previewName.textContent = values.name;
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

    form.querySelectorAll('input, select, textarea').forEach(function (input) { input.disabled = true; });
    dropZone.setAttribute('aria-disabled', 'true');
    document.querySelector('.preview').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  render();
  loadEvent();
})();

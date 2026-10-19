/**
 * Admin page: draft the event's own details and its extra form questions
 * without editing server config or restarting. Everything here
 * is staff-only, gated by the same door code as the dashboard and scanner.
 */
(function () {
  'use strict';

  var KEY_STORE = 'osdays.doorKey';   // shared with dash.js on purpose
  var staffKey = localStorage.getItem(KEY_STORE) || '';

  var gate = document.getElementById('admin-gate');
  var body = document.getElementById('admin-body');
  var eventForm = document.getElementById('event-form');
  var fieldsList = document.getElementById('fields-list');
  var rowTemplate = document.getElementById('field-row-template');

  /* --- IST datetime-local helpers ------------------------------------------
     <input type="datetime-local"> has no timezone of its own; every time in
     this system is IST regardless of what the browser is set to, so both
     directions go through Asia/Kolkata explicitly rather than the machine's
     local zone. */

  function isoToIstInput(iso) {
    if (!iso) return '';
    var when = new Date(iso);
    if (isNaN(when.getTime())) return '';
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(when).reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
    return parts.year + '-' + parts.month + '-' + parts.day + 'T' + parts.hour + ':' + parts.minute;
  }

  function istInputToIso(value) {
    return value ? value + ':00+05:30' : '';
  }

  /* --- status messages ------------------------------------------------------ */

  function setStatus(id, tone, text) {
    var el = document.getElementById(id);
    el.setAttribute('data-tone', tone || '');
    el.textContent = text || '';
  }

  /* --- event details form ---------------------------------------------------- */

  function populateEventForm(ev) {
    var f = eventForm.elements;
    f.name.value = ev.name || '';
    f.edition.value = ev.edition || '';
    f.tagline.value = ev.tagline || '';
    f.venue.value = ev.venue || '';
    f.venueLine.value = ev.venueLine || '';
    f.doorsAt.value = isoToIstInput(ev.doorsAt);
    f.startsAt.value = isoToIstInput(ev.startsAt);
    f.endsAt.value = isoToIstInput(ev.endsAt);
    f.registrationClosesAt.value = isoToIstInput(ev.registrationClosesAt);
    f.amount.value = ev.amount != null ? ev.amount : '';
    f.currency.value = ev.currency || 'INR';
    f.supportEmail.value = ev.supportEmail || '';
    f.purgeAfterHours.value = ev.purgeAfterHours != null ? ev.purgeAfterHours : '';
  }

  function collectEventPatch() {
    var f = eventForm.elements;
    return {
      name: f.name.value.trim(),
      edition: f.edition.value.trim(),
      tagline: f.tagline.value.trim(),
      venue: f.venue.value.trim(),
      venueLine: f.venueLine.value.trim(),
      doorsAt: istInputToIso(f.doorsAt.value),
      startsAt: istInputToIso(f.startsAt.value),
      endsAt: istInputToIso(f.endsAt.value),
      registrationClosesAt: istInputToIso(f.registrationClosesAt.value),
      amount: Number(f.amount.value),
      currency: (f.currency.value.trim() || 'INR').toUpperCase(),
      supportEmail: f.supportEmail.value.trim(),
      purgeAfterHours: Number(f.purgeAfterHours.value)
    };
  }

  eventForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    setStatus('event-status', '', 'Saving…');
    try {
      var result = await API.updateEvent(collectEventPatch(), staffKey);
      if (!result.ok) {
        setStatus('event-status', 'error', result.error || 'Could not save.');
        return;
      }
      populateEventForm(result.event);
      setStatus('event-status', 'ok', 'Saved.');
    } catch (err) {
      setStatus('event-status', 'error', err.message);
    }
  });

  /* --- form-questions editor -------------------------------------------------- */

  function addFieldRow(field) {
    field = field || {};
    var node = rowTemplate.content.firstElementChild.cloneNode(true);

    var labelInput = node.querySelector('.f-label');
    var typeSelect = node.querySelector('.f-type');
    var requiredCheck = node.querySelector('.f-required');
    var optionsField = node.querySelector('.f-options-field');
    var optionsInput = node.querySelector('.f-options');

    function hasOptions(type) {
      return type === 'select' || type === 'multiselect';
    }

    labelInput.value = field.label || '';
    typeSelect.value = field.type || 'text';
    requiredCheck.checked = Boolean(field.required);
    optionsInput.value = (field.options || []).join(', ');
    optionsField.hidden = !hasOptions(typeSelect.value);

    typeSelect.addEventListener('change', function () {
      optionsField.hidden = !hasOptions(typeSelect.value);
    });

    node.querySelector('.f-remove').addEventListener('click', function () {
      node.remove();
    });

    fieldsList.appendChild(node);
  }

  function loadFieldsIntoUI(fields) {
    fieldsList.innerHTML = '';
    (fields || []).forEach(addFieldRow);
  }

  function collectFieldsFromUI() {
    return Array.prototype.map.call(fieldsList.children, function (row) {
      var type = row.querySelector('.f-type').value;
      return {
        label: row.querySelector('.f-label').value.trim(),
        type: type,
        required: row.querySelector('.f-required').checked,
        options: row.querySelector('.f-options').value
      };
    }).filter(function (f) { return f.label; });
  }

  document.getElementById('add-field').addEventListener('click', function () {
    addFieldRow({});
  });

  document.getElementById('save-fields').addEventListener('click', async function () {
    setStatus('fields-status', '', 'Saving…');
    try {
      var result = await API.updateFormFields(collectFieldsFromUI(), staffKey);
      if (!result.ok) {
        setStatus('fields-status', 'error', result.error || 'Could not save.');
        return;
      }
      loadFieldsIntoUI(result.fields);
      setStatus('fields-status', 'ok', 'Saved.');
    } catch (err) {
      setStatus('fields-status', 'error', err.message);
    }
  });

  /* --- start next edition ----------------------------------------------------- */

  document.getElementById('next-edition').addEventListener('click', async function () {
    if (!window.confirm('Purge every attendee row for the current event, and start the next one with the details saved above? This cannot be undone.')) {
      return;
    }
    setStatus('next-status', '', 'Working…');
    try {
      var result = await API.startNextEdition(collectEventPatch(), staffKey);
      if (!result.ok) {
        setStatus('next-status', 'error', result.error || 'Could not start the next edition.');
        return;
      }
      populateEventForm(result.event);
      setStatus('next-status', 'ok',
        'Done — ' + (result.purged ? result.purged.registered : 0) + ' rows purged. Registration is open again.');
    } catch (err) {
      setStatus('next-status', 'error', err.message);
    }
  });

  /* --- appearance / theme editor --------------------------------------------- */

  var themeRaw = { register: {}, staff: {} };
  var themeResolved = null;
  var themeOptions = null;
  var activeThemeSurface = 'register';

  var COLOR_FIELDS = [
    { key: 'bg', label: 'Page background' },
    { key: 'ink', label: 'Text' },
    { key: 'accent', label: 'Accent / focus' },
    { key: 'headerBg', label: 'Top bar' },
    { key: 'headerText', label: 'Top bar text' },
    { key: 'btnPrimaryBg', label: 'Primary button' },
    { key: 'btnPrimaryText', label: 'Button text' }
  ];

  function hexForPicker(value) {
    if (/^#[0-9A-Fa-f]{6}$/.test(String(value || ''))) return value;
    return '#888888';
  }

  function buildThemeEditor(surface) {
    var container = document.getElementById('theme-editor-' + surface);
    if (!container || !themeOptions) return;

    var raw = themeRaw[surface] || {};
    var resolved = Theme.resolveForPreview(raw);
    var bg = raw.background || { type: 'default', imageUrl: '', pattern: 'none', overlayOpacity: 0.35, animate: true };
    var fonts = raw.fonts || {};

    container.innerHTML =
      '<div class="theme-panel">' +
        '<label class="field"><span class="label">Base preset</span>' +
          '<select class="t-preset" data-surface="' + surface + '">' +
            themeOptions.presets.map(function (p) {
              return '<option value="' + p + '"' + (raw.preset === p ? ' selected' : '') + '>' +
                (p === 'day' ? 'Day (warm ivory)' : p === 'night' ? 'Night (dark)' : 'Space (indigo)') +
              '</option>';
            }).join('') +
          '</select></label>' +
        '<p class="theme-subhead">Colours</p>' +
        COLOR_FIELDS.map(function (field) {
          var val = (resolved.colors && resolved.colors[field.key]) || '#888888';
          return '<div class="theme-color-row">' +
            '<span class="label">' + field.label + '</span>' +
            '<input type="color" class="t-color-picker" data-surface="' + surface + '" data-key="' + field.key + '" value="' + hexForPicker(val) + '">' +
            '<input type="text" class="t-color-text" data-surface="' + surface + '" data-key="' + field.key + '" value="' + val + '" spellcheck="false">' +
          '</div>';
        }).join('') +
        '<p class="theme-subhead">Fonts</p>' +
        '<div class="admin-grid admin-grid--3">' +
          fontSelect('Display headings', 'display', surface, fonts.display, themeOptions.fonts.display) +
          fontSelect('Body text', 'body', surface, fonts.body, themeOptions.fonts.body) +
          fontSelect('Labels & data', 'mono', surface, fonts.mono, themeOptions.fonts.mono) +
        '</div>' +
        '<p class="theme-subhead">Background</p>' +
        '<label class="field"><span class="label">Type</span>' +
          '<select class="t-bg-type" data-surface="' + surface + '">' +
            '<option value="default"' + (bg.type === 'default' ? ' selected' : '') + '>Drifting gradients (default)</option>' +
            '<option value="image"' + (bg.type === 'image' ? ' selected' : '') + '>Photo or image</option>' +
            '<option value="pattern"' + (bg.type === 'pattern' ? ' selected' : '') + '>Built-in pattern</option>' +
          '</select></label>' +
        '<div class="theme-bg-fields t-bg-image" data-surface="' + surface + '"' + (bg.type === 'image' ? '' : ' hidden') + '>' +
          '<div class="theme-upload" data-surface="' + surface + '">' +
            '<input type="file" class="t-bg-file" data-surface="' + surface + '" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden>' +
            '<div class="theme-upload__drop" data-surface="' + surface + '" tabindex="0" role="button">Drop an image from your desktop, or click to browse</div>' +
            '<img class="theme-upload__preview" data-surface="' + surface + '" alt="" hidden>' +
            '<p class="theme-upload__meta" data-surface="' + surface + '"></p>' +
          '</div>' +
          '<p class="admin-hint">Photos are resized to 1920px before upload. On screen the image uses <em>cover</em> scaling — it fills the viewport and may crop edges; pick an anchor below.</p>' +
          '<label class="field"><span class="label">Crop anchor (cover scaling)</span>' +
            '<select class="t-bg-position" data-surface="' + surface + '">' +
              '<option value="center"' + ((bg.position || 'center') === 'center' ? ' selected' : '') + '>Centre</option>' +
              '<option value="top"' + (bg.position === 'top' ? ' selected' : '') + '>Top</option>' +
              '<option value="bottom"' + (bg.position === 'bottom' ? ' selected' : '') + '>Bottom</option>' +
            '</select></label>' +
          '<label class="field field--inline"><span class="label">Darken overlay</span>' +
            '<input type="range" class="t-bg-overlay" data-surface="' + surface + '" min="0" max="100" value="' + Math.round((bg.overlayOpacity != null ? bg.overlayOpacity : 0.35) * 100) + '">' +
            '<output class="t-bg-overlay-out" data-surface="' + surface + '">' + Math.round((bg.overlayOpacity != null ? bg.overlayOpacity : 0.35) * 100) + '%</output>' +
          '</label>' +
          '<label class="field"><span class="label">Or paste an image URL (https://)</span>' +
            '<input type="url" class="t-bg-url" data-surface="' + surface + '" value="' + (bg.imageUrl || '') + '" placeholder="https://…">' +
          '</label>' +
        '</div>' +
        '<div class="theme-bg-fields t-bg-pattern-wrap" data-surface="' + surface + '"' + (bg.type === 'pattern' ? '' : ' hidden') + '>' +
          '<label class="field"><span class="label">Pattern</span>' +
            '<select class="t-bg-pattern" data-surface="' + surface + '">' +
              themeOptions.patterns.filter(function (p) { return p !== 'none'; }).map(function (p) {
                return '<option value="' + p + '"' + (bg.pattern === p ? ' selected' : '') + '>' +
                  (p === 'stars' ? 'Stars' : p === 'grain' ? 'Paper grain' : 'Dots') +
                '</option>';
              }).join('') +
            '</select></label>' +
        '</div>' +
        '<label class="field field--checkbox admin-field-row__required">' +
          '<input type="checkbox" class="t-bg-animate" data-surface="' + surface + '"' + (bg.animate !== false ? ' checked' : '') + '>' +
          '<span class="label">Animate the ambient background wash</span>' +
        '</label>' +
      '</div>' +
      '<div class="theme-preview" id="theme-preview-' + surface + '">' +
        '<div class="theme-preview__bar">Event title</div>' +
        '<div class="theme-preview__body">' +
          '<p>Body text and form labels look like this.</p>' +
          '<button type="button" class="btn btn--primary">Primary button</button>' +
        '</div>' +
      '</div>';

    wireThemeEditor(surface);
    refreshThemePreview(surface);
  }

  function fontSelect(label, role, surface, current, options) {
    return '<label class="field"><span class="label">' + label + '</span>' +
      '<select class="t-font" data-surface="' + surface + '" data-role="' + role + '">' +
        '<option value="">Preset default</option>' +
        (options || []).map(function (name) {
          return '<option value="' + name + '"' + (current === name ? ' selected' : '') + '>' + name + '</option>';
        }).join('') +
      '</select></label>';
  }

  function ensureSurfaceRaw(surface) {
    if (!themeRaw[surface]) {
      themeRaw[surface] = { preset: surface === 'staff' ? 'night' : 'day', colors: {}, fonts: {}, background: { type: 'default', imageUrl: '', pattern: 'stars', overlayOpacity: 0.35, animate: true } };
    }
    if (!themeRaw[surface].background) themeRaw[surface].background = { type: 'default', imageUrl: '', pattern: 'stars', overlayOpacity: 0.35, animate: true };
    if (!themeRaw[surface].colors) themeRaw[surface].colors = {};
    if (!themeRaw[surface].fonts) themeRaw[surface].fonts = {};
  }

  function readThemeControl(surface) {
    ensureSurfaceRaw(surface);
    var panel = document.getElementById('theme-editor-' + surface);
    if (!panel) return themeRaw[surface];

    themeRaw[surface].preset = panel.querySelector('.t-preset').value;
    themeRaw[surface].colors = {};
    panel.querySelectorAll('.t-color-text').forEach(function (input) {
      var val = input.value.trim();
      if (/^#[0-9A-Fa-f]{6}$/.test(val) || /^rgba?\(/i.test(val)) {
        themeRaw[surface].colors[input.getAttribute('data-key')] = val;
      }
    });

    themeRaw[surface].fonts = {};
    panel.querySelectorAll('.t-font').forEach(function (select) {
      if (select.value) themeRaw[surface].fonts[select.getAttribute('data-role')] = select.value;
    });

    var bgType = panel.querySelector('.t-bg-type').value;
    themeRaw[surface].background = {
      type: bgType,
      imageUrl: (panel.querySelector('.t-bg-url') || {}).value || '',
      pattern: (panel.querySelector('.t-bg-pattern') || {}).value || 'stars',
      overlayOpacity: Number((panel.querySelector('.t-bg-overlay') || {}).value || 35) / 100,
      animate: panel.querySelector('.t-bg-animate').checked,
      position: (panel.querySelector('.t-bg-position') || {}).value || 'center'
    };
    return themeRaw[surface];
  }

  function refreshThemePreview(surface) {
    readThemeControl(surface);
    Theme.applyToElement(document.getElementById('theme-preview-' + surface), Theme.resolveForPreview(themeRaw[surface]));
  }

  function wireThemeEditor(surface) {
    var panel = document.getElementById('theme-editor-' + surface);
    if (!panel) return;

    panel.querySelector('.t-preset').addEventListener('change', function () {
      themeRaw[surface].preset = panel.querySelector('.t-preset').value;
      themeRaw[surface].colors = {};
      themeRaw[surface].fonts = {};
      buildThemeEditors();
    });

    panel.querySelectorAll('.t-color-picker').forEach(function (picker) {
      picker.addEventListener('input', function () {
        var key = picker.getAttribute('data-key');
        panel.querySelector('.t-color-text[data-key="' + key + '"]').value = picker.value;
        refreshThemePreview(surface);
      });
    });

    panel.querySelectorAll('.t-color-text').forEach(function (text) {
      text.addEventListener('input', function () {
        var key = text.getAttribute('data-key');
        if (/^#[0-9A-Fa-f]{6}$/.test(text.value)) {
          panel.querySelector('.t-color-picker[data-key="' + key + '"]').value = text.value;
        }
        refreshThemePreview(surface);
      });
    });

    panel.querySelectorAll('.t-font, .t-bg-type, .t-bg-url, .t-bg-pattern, .t-bg-animate, .t-bg-position').forEach(function (el) {
      el.addEventListener('change', function () { refreshThemePreview(surface); });
      el.addEventListener('input', function () { refreshThemePreview(surface); });
    });

    wireBackgroundUpload(surface, panel);

    panel.querySelector('.t-bg-type').addEventListener('change', function () {
      var type = panel.querySelector('.t-bg-type').value;
      panel.querySelector('.t-bg-image').hidden = type !== 'image';
      panel.querySelector('.t-bg-pattern-wrap').hidden = type !== 'pattern';
    });

    var overlay = panel.querySelector('.t-bg-overlay');
    if (overlay) {
      overlay.addEventListener('input', function () {
        panel.querySelector('.t-bg-overlay-out').textContent = overlay.value + '%';
        refreshThemePreview(surface);
      });
    }
  }

  function wireBackgroundUpload(surface, panel) {
    var drop = panel.querySelector('.theme-upload__drop[data-surface="' + surface + '"]');
    var fileInput = panel.querySelector('.t-bg-file[data-surface="' + surface + '"]');
    var preview = panel.querySelector('.theme-upload__preview[data-surface="' + surface + '"]');
    var meta = panel.querySelector('.theme-upload__meta[data-surface="' + surface + '"]');
    if (!drop || !fileInput) return;

    function pick() { fileInput.click(); }

    drop.addEventListener('click', pick);
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });

    drop.addEventListener('dragover', function (e) {
      e.preventDefault();
      drop.setAttribute('data-drag', 'true');
    });
    drop.addEventListener('dragleave', function () { drop.removeAttribute('data-drag'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      drop.removeAttribute('data-drag');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) uploadBackground(surface, panel, e.dataTransfer.files[0], preview, meta);
    });

    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) uploadBackground(surface, panel, fileInput.files[0], preview, meta);
      fileInput.value = '';
    });

    if (panel.querySelector('.t-bg-url').value && preview) {
      preview.src = panel.querySelector('.t-bg-url').value;
      preview.hidden = false;
    }
  }

  async function uploadBackground(surface, panel, file, preview, meta) {
    if (!staffKey) {
      meta.textContent = 'Sign in as staff before uploading.';
      return;
    }
    meta.textContent = 'Preparing…';
    try {
      var prep = await ImageUpload.prepareBackgroundFile(file);
      if (!prep.ok) {
        meta.textContent = prep.error;
        return;
      }
      if (prep.preview && preview) {
        preview.src = prep.preview;
        preview.hidden = false;
      }
      meta.textContent = (prep.meta || '') + ' · uploading…';

      var result = await API.uploadAsset(prep.asset, staffKey);
      if (!result.ok) {
        meta.textContent = result.error || 'Upload failed.';
        return;
      }

      panel.querySelector('.t-bg-type').value = 'image';
      panel.querySelector('.t-bg-image').hidden = false;
      panel.querySelector('.t-bg-url').value = result.url;
      if (preview && !preview.src) {
        preview.src = result.url;
        preview.hidden = false;
      }
      meta.textContent = (prep.meta || 'Uploaded') + ' · click Save appearance to keep.';
      refreshThemePreview(surface);
    } catch (err) {
      meta.textContent = err.message;
    }
  }

  function buildThemeEditors() {
    ['register', 'staff'].forEach(buildThemeEditor);
  }

  function loadThemeIntoUI(data) {
    themeRaw = data.theme || { register: {}, staff: {} };
    themeResolved = data.themeResolved || null;
    themeOptions = data.themeOptions || null;
    ensureSurfaceRaw('register');
    ensureSurfaceRaw('staff');
    buildThemeEditors();
    if (themeResolved) Theme.apply(themeResolved, 'staff');
  }

  document.querySelectorAll('.theme-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      activeThemeSurface = tab.getAttribute('data-surface');
      document.querySelectorAll('.theme-tab').forEach(function (t) {
        var on = t === tab;
        t.classList.toggle('theme-tab--active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      document.querySelectorAll('.theme-editor').forEach(function (panel) {
        panel.hidden = panel.getAttribute('data-surface') !== activeThemeSurface;
      });
    });
  });

  document.getElementById('save-theme').addEventListener('click', async function () {
    setStatus('theme-status', '', 'Saving…');
    readThemeControl('register');
    readThemeControl('staff');
    try {
      var result = await API.updateTheme(themeRaw, staffKey);
      if (!result.ok) {
        setStatus('theme-status', 'error', result.error || 'Could not save.');
        return;
      }
      themeRaw = result.raw || themeRaw;
      themeResolved = result.theme || themeResolved;
      buildThemeEditors();
      Theme.apply(themeResolved, 'staff');
      setStatus('theme-status', 'ok', 'Saved — registration and staff pages will pick this up.');
    } catch (err) {
      setStatus('theme-status', 'error', err.message);
    }
  });

  document.getElementById('reset-theme-colors').addEventListener('click', function () {
    ensureSurfaceRaw(activeThemeSurface);
    themeRaw[activeThemeSurface].colors = {};
    buildThemeEditor(activeThemeSurface);
    setStatus('theme-status', '', 'Colours reset to the preset for this tab.');
  });

  /* --- staff sign-in, sign-out ------------------------------------------------ */

  var sheet = document.getElementById('staff-sheet');
  var staffBtn = document.getElementById('staff-toggle');

  function updateStaffButton() {
    staffBtn.textContent = staffKey ? 'Sign out' : 'Sign in as staff';
  }

  function showGate(message) {
    body.hidden = true;
    gate.hidden = false;
    gate.querySelector('.lede').textContent =
      message || 'Sign in as staff to draft the event, add form questions, or start the next edition.';
  }

  async function loadAdmin() {
    try {
      var data = await API.adminConfig(staffKey);
      if (!data.ok) {
        staffKey = '';
        localStorage.removeItem(KEY_STORE);
        updateStaffButton();
        showGate('That door code is not recognised any more. Sign in again.');
        return;
      }
      gate.hidden = true;
      body.hidden = false;
      populateEventForm(data.event);
      loadFieldsIntoUI(data.fields);
      loadThemeIntoUI(data);
    } catch (err) {
      showGate(err.message);
    }
  }

  function openSignIn() {
    sheet.hidden = false;
    document.getElementById('staff-key').focus();
  }

  staffBtn.addEventListener('click', function () {
    if (staffKey) {
      staffKey = '';
      localStorage.removeItem(KEY_STORE);
      updateStaffButton();
      showGate();
      return;
    }
    openSignIn();
  });

  document.getElementById('gate-sign-in').addEventListener('click', openSignIn);

  document.getElementById('staff-cancel').addEventListener('click', function () {
    sheet.hidden = true;
  });

  document.getElementById('staff-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var input = document.getElementById('staff-key');
    var errorSlot = document.getElementById('staff-error');
    var candidate = input.value.trim().toUpperCase();

    errorSlot.textContent = 'Checking…';
    try {
      var data = await API.adminConfig(candidate);
      if (!data.ok) {
        errorSlot.textContent = 'That code is not recognised.';
        input.select();
        return;
      }
      staffKey = candidate;
      localStorage.setItem(KEY_STORE, staffKey);
      errorSlot.textContent = '';
      sheet.hidden = true;
      updateStaffButton();
      gate.hidden = true;
      body.hidden = false;
      populateEventForm(data.event);
      loadFieldsIntoUI(data.fields);
      loadThemeIntoUI(data);
    } catch (err) {
      errorSlot.textContent = err.message;
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !sheet.hidden) sheet.hidden = true;
  });

  /* --- boot -------------------------------------------------------------------- */

  updateStaffButton();
  if (staffKey) {
    loadAdmin();
  } else {
    showGate();
  }
})();

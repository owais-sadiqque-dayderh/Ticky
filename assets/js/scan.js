/* Door scanner. Camera in, verdict out, nothing in between to think about. */
(function () {
  'use strict';

  var KEY_STORE = 'osdays.doorKey';
  var SOUND_STORE = 'osdays.doorSound';

  var gate = document.getElementById('gate');
  var scanner = document.getElementById('scanner');
  var verdict = document.getElementById('verdict');
  var hint = document.getElementById('viewport-hint');

  var doorKey = localStorage.getItem(KEY_STORE) || '';
  var soundOn = localStorage.getItem(SOUND_STORE) !== 'off';
  var reader = null;
  var busy = false;
  var lastCode = { value: '', at: 0 };

  /* --- gate --------------------------------------------------------------- */

  document.getElementById('gate-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var input = document.getElementById('gate-key');
    var errorSlot = document.getElementById('gate-error');
    var candidate = input.value.trim().toUpperCase();

    if (!candidate) {
      errorSlot.textContent = 'Enter the door code to start.';
      return;
    }

    errorSlot.textContent = 'Checking…';
    try {
      var data = await API.stats(candidate);
      if (!data.ok || !data.staff) {
        errorSlot.textContent = 'That code is not recognised. Ask the organiser for the current one.';
        input.select();
        return;
      }
      doorKey = candidate;
      localStorage.setItem(KEY_STORE, doorKey);
      errorSlot.textContent = '';
      start(data);
    } catch (err) {
      errorSlot.textContent = err.message;
    }
  });

  document.getElementById('sign-out').addEventListener('click', function () {
    localStorage.removeItem(KEY_STORE);
    location.reload();
  });

  /* --- sound -------------------------------------------------------------- */
  /* A door is loud and nobody is looking at the screen. Two tones carry the
     verdict without anyone having to read it. */

  var audioCtx = null;

  function beep(kind) {
    if (!soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      var now = audioCtx.currentTime;
      osc.type = 'sine';
      if (kind === 'ok') {
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(1320, now + 0.08);
      } else {
        osc.frequency.setValueAtTime(300, now);
        osc.frequency.setValueAtTime(200, now + 0.12);
      }
      gain.gain.setValueAtTime(0.16, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.32);
    } catch (err) {
      /* audio is a nicety, never a blocker */
    }
  }

  function buzz(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  var soundBtn = document.getElementById('toggle-sound');
  soundBtn.setAttribute('aria-pressed', String(soundOn));
  soundBtn.title = soundOn ? 'Sound on' : 'Sound off';
  soundBtn.addEventListener('click', function () {
    soundOn = !soundOn;
    localStorage.setItem(SOUND_STORE, soundOn ? 'on' : 'off');
    soundBtn.setAttribute('aria-pressed', String(soundOn));
    soundBtn.title = soundOn ? 'Sound on' : 'Sound off';
    if (soundOn) beep('ok');
  });

  /* --- start -------------------------------------------------------------- */

  function start(data) {
    gate.hidden = true;
    scanner.hidden = false;
    if (data) applyStats(data);
    startCamera();
    setInterval(refreshCounts, (API.config.POLL_MS || 12000) * 2);
  }

  function applyStats(data) {
    if (data.event) document.getElementById('bar-event').textContent = data.event.name;
    if (data.counts) {
      document.getElementById('bar-in').textContent = data.counts.checkedIn;
      document.getElementById('bar-ticketed').textContent = data.counts.ticketed;
    }
    if (data.theme) Theme.apply(data.theme, 'staff');
  }

  async function refreshCounts() {
    try {
      applyStats(await API.stats(doorKey));
    } catch (err) {
      /* the door keeps working whether or not the count refreshes */
    }
  }

  function startCamera() {
    if (typeof Html5Qrcode === 'undefined') {
      setHint('QR library could not load. Use "type the ticket number" below.', 'error');
      return;
    }

    reader = new Html5Qrcode('reader', { verbose: false });
    reader.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 220, height: 220 }, aspectRatio: 1.0 },
      onScan,
      function () { /* per-frame decode misses are normal; stay quiet */ }
    ).catch(function (err) {
      setHint('No camera access. Allow the camera, or type the ticket number below.', 'error');
      console.warn(err);
    });
  }

  function setHint(text, tone) {
    hint.textContent = text;
    if (tone) hint.setAttribute('data-tone', tone);
    else hint.removeAttribute('data-tone');
  }

  /* --- scanning ------------------------------------------------------------ */

  function onScan(decodedText) {
    var now = Date.now();
    // One ticket held in front of the camera decodes many times a second.
    if (busy || (decodedText === lastCode.value && now - lastCode.at < 4000)) return;
    lastCode = { value: decodedText, at: now };
    check({ payload: decodedText });
  }

  document.getElementById('manual-toggle').addEventListener('click', function (e) {
    var form = document.getElementById('manual-form');
    form.hidden = !form.hidden;
    e.currentTarget.textContent = form.hidden ? 'Camera not working?' : 'Hide manual entry';
    if (!form.hidden) document.getElementById('manual-id').focus();
  });

  document.getElementById('manual-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = document.getElementById('manual-id');
    var value = input.value.trim().toUpperCase();
    if (!value) return;
    input.value = '';
    check({ ticketId: value });
  });

  async function check(request) {
    busy = true;
    showChecking();

    try {
      var result = request.payload
        ? await API.checkin(request.payload, doorKey)
        : await API.checkinByNumber(request.ticketId, doorKey);

      if (!result.ok) {
        showVerdict({
          state: 'ERROR',
          headline: result.code === 'FORBIDDEN' ? 'Door code expired' : 'Could not check',
          detail: result.error
        });
        return;
      }

      renderResult(result);
      refreshCounts();
    } catch (err) {
      showVerdict({ state: 'ERROR', headline: 'No connection', detail: err.message });
    }
  }

  var HEADLINE = {
    VALID: 'Let them in',
    ALREADY_USED: 'Already used',
    REVOKED: 'Cancelled',
    UNKNOWN: 'Not our ticket',
    INVALID: 'Forged',
    WRONG_EVENT: 'Wrong edition'
  };

  var STATE_LABEL = {
    VALID: 'Checked in',
    ALREADY_USED: 'Used',
    REVOKED: 'Revoked',
    UNKNOWN: 'Unknown',
    INVALID: 'Invalid signature',
    WRONG_EVENT: 'Wrong event'
  };

  function renderResult(result) {
    showVerdict({
      state: result.state,
      label: STATE_LABEL[result.state] || result.state,
      headline: HEADLINE[result.state] || result.state,
      name: result.name || '',
      ticketId: result.ticketId || '',
      detail: result.message || ''
    });

    if (result.state === 'VALID') {
      beep('ok');
      buzz(40);
      // A clean scan needs no decision, so it clears itself and the next person
      // steps up. Anything else waits for a human to acknowledge it.
      setTimeout(dismiss, 2200);
    } else {
      beep('bad');
      buzz([60, 60, 60]);
    }
  }

  function showChecking() {
    verdict.hidden = false;
    verdict.setAttribute('data-state', 'checking');
    document.getElementById('verdict-state').textContent = 'Checking signature';
    document.getElementById('verdict-headline').textContent = '…';
    document.getElementById('verdict-name').textContent = '';
    document.getElementById('verdict-ticket').textContent = '';
    document.getElementById('verdict-detail').textContent = '';
    document.getElementById('verdict-next').hidden = true;
  }

  function showVerdict(v) {
    verdict.hidden = false;
    verdict.setAttribute('data-state', v.state);
    document.getElementById('verdict-state').textContent = v.label || v.state;
    document.getElementById('verdict-headline').textContent = v.headline;
    document.getElementById('verdict-name').textContent = v.name || '';
    document.getElementById('verdict-ticket').textContent = v.ticketId || '';
    document.getElementById('verdict-detail').textContent = v.detail || '';

    var next = document.getElementById('verdict-next');
    next.hidden = false;
    next.focus();
  }

  function dismiss() {
    verdict.hidden = true;
    verdict.removeAttribute('data-state');
    busy = false;
  }

  document.getElementById('verdict-next').addEventListener('click', dismiss);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !verdict.hidden) dismiss();
  });

  /* --- boot --------------------------------------------------------------- */

  if (doorKey) {
    start(null);
    refreshCounts();
  }
})();

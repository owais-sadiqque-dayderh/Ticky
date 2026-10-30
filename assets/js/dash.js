/* Live dashboard. Polls the same Sheet the door writes to. */
(function () {
  'use strict';

  var CFG = window.OSDAYS_CONFIG || {};
  var KEY_STORE = 'osdays.doorKey';

  var staffKey = localStorage.getItem(KEY_STORE) || '';
  var event = Object.assign({}, CFG.FALLBACK_EVENT);
  var registration = null;
  var attendees = [];
  var formFields = [];
  var seenCheckins = new Set();
  var firstPaint = true;

  var live = document.getElementById('live');
  var liveText = document.getElementById('live-text');

  /* --- the venue clock ------------------------------------------------------
     Indian Standard Time, not this machine's time. A dashboard watched from a
     laptop that is still on a plane's timezone should still agree with the
     wall. */

  var clock = document.getElementById('clock');

  function tick() {
    clock.textContent = fmt.istTime(new Date());
    clock.dateTime = new Date().toISOString();
  }

  tick();
  setInterval(tick, 20000);

  /* --- rendering ----------------------------------------------------------- */

  function set(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function bind(values) {
    Object.keys(values).forEach(function (key) {
      document.querySelectorAll('[data-bind="' + key + '"]').forEach(function (el) {
        if (values[key]) el.textContent = values[key];
      });
    });
  }

  /**
   * Staff only, and only when there is something to act on. "Our email is down"
   * is not a thing to announce on a page anyone can open.
   */
  function renderAlarm(counts, staff) {
    var box = document.getElementById('alarm');
    var stuck = counts.undelivered || 0;

    if (!staff || !stuck) {
      box.hidden = true;
      return;
    }

    box.hidden = false;
    document.getElementById('alarm-detail').textContent =
      stuck + (stuck === 1 ? ' ticket has' : ' tickets have') + ' been issued but the email never left';
  }

  function renderCounts(counts, staff) {
    var pct = counts.registered ? Math.round((counts.checkedIn / counts.registered) * 100) : 0;

    set('stat-in', counts.checkedIn);
    set('stat-ticketed', counts.registered);
    set('stat-pct', pct);
    set('stat-registered', counts.registered);
    set('stat-expected', counts.expected);
    set('stat-undelivered', counts.undelivered);

    // The count is public but only staff can do anything with it, so only staff
    // are shown the tile.
    document.getElementById('tile-undelivered').hidden = !staff || !counts.undelivered;
    renderArrivals(counts);
  }

  /**
   * One mark per person registered, filled as they walk in. The row grows with
   * the guest list rather than standing in for a fixed number of seats — there
   * isn't one.
   */
  function renderArrivals(counts) {
    var grid = document.getElementById('arrivals');
    var total = Number(counts.registered) || 0;

    while (grid.children.length > total) grid.removeChild(grid.lastChild);
    while (grid.children.length < total) grid.appendChild(document.createElement('i'));

    Array.prototype.forEach.call(grid.children, function (mark, i) {
      var state = i < counts.checkedIn ? 'in' : 'out';
      if (mark.getAttribute('data-state') !== state) mark.setAttribute('data-state', state);
    });

    grid.setAttribute('aria-label',
      counts.checkedIn + ' of ' + total + ' registered attendees are in the room');
  }

  /**
   * The open/close switch. Anyone can see whether the form is taking responses;
   * only staff can change it.
   */
  function renderRegistration(state, staff) {
    registration = state || registration;
    if (!registration) return;

    var open = registration.open;
    var tile = document.getElementById('tile-registration');
    var button = document.getElementById('reg-toggle');

    tile.setAttribute('data-state', open ? 'open' : 'closed');
    set('reg-state', open ? 'Open' : 'Closed');
    set('reg-note', open
      ? (registration.closesAt ? 'until ' + fmt.dayLabel(registration.closesAt) : 'taking responses')
      : 'the form turns people away');

    button.hidden = !staff;
    button.textContent = open ? 'Close the form' : 'Re-open the form';
  }

  function renderFeed(recent) {
    var list = document.getElementById('feed');
    var empty = document.getElementById('feed-empty');

    empty.hidden = recent.length > 0;
    list.innerHTML = '';

    recent.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'feed__item';
      // Only genuinely new arrivals animate; a poll refresh should not replay
      // the whole feed every twelve seconds.
      if (firstPaint || seenCheckins.has(item.ticketId)) li.style.animation = 'none';
      seenCheckins.add(item.ticketId);

      var name = document.createElement('span');
      name.className = 'feed__name';
      name.textContent = item.name;

      var at = document.createElement('time');
      at.className = 'feed__at';
      at.dateTime = item.at || '';
      at.textContent = fmt.clockTime(item.at);

      li.appendChild(name);
      li.appendChild(at);
      list.appendChild(li);
    });
  }

  /**
   * a.formAnswers is keyed by field slug (e.g. "t_shirt_size"), not the
   * question someone actually typed — matched back against the schema so the
   * roster reads as "T-shirt size: M", not "t_shirt_size: M".
   */
  function formatAnswers(raw) {
    if (!raw) return [];
    return formFields
      .filter(function (f) { return raw[f.key] !== undefined; })
      .map(function (f) {
        var value = raw[f.key];
        var text = f.type === 'multiselect' ? value.join(', ')
          : value === true ? 'Yes'
          : String(value);
        return { label: f.label, value: text };
      });
  }

  function renderRoster() {
    var table = document.getElementById('roster-table');
    var body = document.getElementById('roster-body');
    var empty = document.getElementById('roster-empty');
    var query = document.getElementById('roster-search').value.trim().toLowerCase();

    if (!staffKey || !attendees.length) {
      table.hidden = true;
      empty.hidden = false;
      empty.textContent = staffKey
        ? 'Nobody has registered yet.'
        : 'Sign in with the door code to see who has registered.';
      return;
    }

    var rows = attendees.filter(function (a) {
      if (!query) return true;
      return [a.name, a.email, a.ticketId, a.phone]
        .join(' ').toLowerCase().indexOf(query) >= 0;
    });

    if (!rows.length) {
      table.hidden = true;
      empty.hidden = false;
      empty.textContent = 'Nobody matches "' + query + '".';
      return;
    }

    empty.hidden = true;
    table.hidden = false;
    body.innerHTML = '';

    rows.forEach(function (a) {
      var tr = document.createElement('tr');

      var who = document.createElement('td');
      var name = document.createElement('div');
      name.className = 'roster__name';
      name.textContent = a.name;
      var email = document.createElement('div');
      email.className = 'roster__email';
      email.textContent = a.email;
      who.appendChild(name);
      who.appendChild(email);

      // Whatever the organiser asked beyond name/email/phone, right under it —
      // this is the only place these answers are visible outside the raw Sheet.
      var answers = formatAnswers(a.formAnswers);
      if (answers.length) {
        var answersBox = document.createElement('div');
        answersBox.className = 'roster__answers';
        answers.forEach(function (line) {
          var row = document.createElement('div');
          var b = document.createElement('b');
          b.textContent = line.label + ': ';
          row.appendChild(b);
          row.appendChild(document.createTextNode(line.value));
          answersBox.appendChild(row);
        });
        who.appendChild(answersBox);
      }

      // The screenshot is one tap away rather than on screen: it is only ever
      // wanted for the rare row someone is actually questioning.
      if (a.proofUrl) {
        var proof = document.createElement('a');
        proof.className = 'roster__proof';
        proof.href = a.proofUrl;
        proof.target = '_blank';
        proof.rel = 'noopener';
        proof.textContent = 'proof';
        who.appendChild(proof);
      }

      var status = document.createElement('td');
      var pill = document.createElement('span');
      pill.className = 'pill';
      // "Their email never arrived" is what staff need to see here; the row's
      // own status only ever reads ISSUED behind it.
      var shown = a.delivered ? a.status : 'UNDELIVERED';
      pill.setAttribute('data-status', shown);
      pill.textContent = shown === 'UNDELIVERED' ? 'email stuck' : shown.replace('_', ' ').toLowerCase();
      status.appendChild(pill);

      // The one place a ticket number is still shown: it is what door staff type
      // in when a camera will not read a screen.
      var ticket = document.createElement('td');
      ticket.className = 'roster__ticket';
      ticket.textContent = a.ticketId || '—';

      var arrived = document.createElement('td');
      arrived.className = 'roster__ticket';
      arrived.textContent = a.checkinAt ? fmt.clockTime(a.checkinAt) : '—';

      [who, status, ticket, arrived].forEach(function (td) { tr.appendChild(td); });
      body.appendChild(tr);
    });
  }

  function setLive(state, text) {
    live.setAttribute('data-state', state);
    liveText.textContent = text;
  }

  /* --- polling ------------------------------------------------------------- */

  async function poll() {
    try {
      var data = await API.stats(staffKey);
      if (!data.ok) throw new API.ApiError(data.error || 'The server could not build the numbers.', data.code);

      event = Object.assign(event, data.event);
      bind({ edition: event.edition, name: event.name, doorsLabel: event.doorsLabel });
      document.title = 'Live — ' + event.name;

      if (data.theme) Theme.apply(data.theme, 'staff');

      document.getElementById('admin-link').hidden = !data.staff;
      renderCounts(data.counts, data.staff);
      renderAlarm(data.counts, data.staff);
      renderRegistration(data.registration, data.staff);
      renderFeed(data.recent || []);

      attendees = data.attendees || [];
      formFields = data.formFields || [];
      renderRoster();

      // A dashboard that silently shows stale numbers is worse than one that
      // admits it is stale, so the timestamp is always visible.
      setLive('live', 'Live ' + fmt.clockTime(data.generatedAt));

      if (staffKey && !data.staff) {
        // Code was rotated mid-event.
        staffKey = '';
        localStorage.removeItem(KEY_STORE);
        updateStaffButton();
      }
      firstPaint = false;
    } catch (err) {
      setLive('error', err.code === 'NOT_CONFIGURED' ? 'Not connected' : 'Reconnecting');
      console.warn(err.message);
    }
  }

  /* --- the registration switch ---------------------------------------------- */

  document.getElementById('reg-toggle').addEventListener('click', async function (e) {
    var button = e.currentTarget;
    var opening = !(registration && registration.open);

    if (!opening && !window.confirm('Stop taking registrations? The form will turn people away until you re-open it.')) {
      return;
    }

    button.disabled = true;
    try {
      var result = await API.setRegistration(opening, staffKey);
      if (result.ok) renderRegistration(result, true);
      poll();
    } catch (err) {
      console.warn(err.message);
    } finally {
      button.disabled = false;
    }
  });

  /* --- staff sign-in -------------------------------------------------------- */

  var sheet = document.getElementById('staff-sheet');
  var staffBtn = document.getElementById('staff-toggle');

  function updateStaffButton() {
    staffBtn.textContent = staffKey ? 'Sign out' : 'Sign in as staff';
  }

  staffBtn.addEventListener('click', function () {
    if (staffKey) {
      staffKey = '';
      localStorage.removeItem(KEY_STORE);
      attendees = [];
      updateStaffButton();
      renderRoster();
      poll();
      return;
    }
    sheet.hidden = false;
    document.getElementById('staff-key').focus();
  });

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
      var data = await API.stats(candidate);
      if (!data.ok || !data.staff) {
        errorSlot.textContent = 'That code is not recognised.';
        input.select();
        return;
      }
      staffKey = candidate;
      localStorage.setItem(KEY_STORE, staffKey);
      errorSlot.textContent = '';
      sheet.hidden = true;
      updateStaffButton();
      poll();
    } catch (err) {
      errorSlot.textContent = err.message;
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !sheet.hidden) sheet.hidden = true;
  });

  document.getElementById('roster-search').addEventListener('input', renderRoster);

  /* --- boot ----------------------------------------------------------------- */

  updateStaffButton();
  poll();
  setInterval(poll, CFG.POLL_MS || 12000);

  // Pause polling in a background tab; catch up the moment it comes back.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) poll();
  });
})();

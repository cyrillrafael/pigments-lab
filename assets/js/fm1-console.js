/*
 * fm1-console.js — browser UI for the FM-1 / SMC-Pad console (fm1.md).
 * All MIDI logic lives in midi-core.js; this file only wires DOM <-> hub.
 * Text is always inserted via textContent (port names are device-supplied).
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    status: $('fm1-status'), connect: $('fm1-connect'), sysex: $('fm1-sysex'),
    input: $('fm1-input-list'), output: $('fm1-output'), forward: $('fm1-forward'),
    test: $('fm1-test'), panic: $('fm1-panic'), channel: $('fm1-channel'),
    program: $('fm1-program'), sendProgram: $('fm1-send-program'),
    pads: $('fm1-pads'), knobs: $('fm1-knobs'), transport: $('fm1-transport'),
    log: $('fm1-log'), clear: $('fm1-clear'), download: $('fm1-download'),
    learnState: $('fm1-learn-state'), learnReset: $('fm1-learn-reset')
  };
  var hub = null;
  var padEls = [], knobEls = [], transportEls = {};
  var PROFILE_KEY = 'fm1.smc-pad.profile.v1';

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.dataset.kind = kind || '';
  }

  function storage(fn) { try { return fn(window.localStorage); } catch (e) { return null; } }

  function loadProfile() {
    var raw = storage(function (s) { return s.getItem(PROFILE_KEY); });
    if (!raw) return null;
    try {
      var p = JSON.parse(raw);
      return p && Array.isArray(p.pads) && Array.isArray(p.knobs) && p.transport ? p : null;
    } catch (e) { return null; }
  }
  function saveProfile(p) { storage(function (s) { s.setItem(PROFILE_KEY, JSON.stringify(p)); }); }

  /* ---------- rendering ---------- */

  function buildSurface() {
    var i;
    els.pads.textContent = '';
    padEls = [];
    for (i = 0; i < 16; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'fm1-pad';
      b.textContent = String(i + 1);
      b.dataset.index = String(i);
      b.title = 'Pad ' + (i + 1) + ' — click to play on the selected output; shift-click to bind (learn)';
      els.pads.appendChild(b);
      padEls.push(b);
    }
    els.knobs.textContent = '';
    knobEls = [];
    for (i = 0; i < 8; i++) {
      var wrap = document.createElement('label');
      wrap.className = 'fm1-knob';
      var cap = document.createElement('span');
      cap.textContent = 'K' + (i + 1);
      var meter = document.createElement('meter');
      meter.min = 0; meter.max = 127; meter.value = 0;
      meter.dataset.index = String(i);
      wrap.appendChild(cap); wrap.appendChild(meter);
      els.knobs.appendChild(wrap);
      knobEls.push(meter);
    }
    els.transport.textContent = '';
    transportEls = {};
    MidiCore.TRANSPORT_SLOTS.concat(['continue']).forEach(function (name) {
      var t = document.createElement('button');
      t.type = 'button';
      t.className = 'fm1-transport-btn';
      t.textContent = name;
      t.dataset.name = name;
      t.title = 'Shift-click to bind this transport button (learn)';
      els.transport.appendChild(t);
      transportEls[name] = t;
    });
  }

  function flash(el) {
    if (!el) return;
    el.classList.add('on');
    window.setTimeout(function () { el.classList.remove('on'); }, 140);
  }

  function describe(msg) {
    switch (msg.type) {
      case 'noteon': case 'noteoff': return 'ch' + msg.channel + ' ' + msg.type + ' ' + msg.note + ' v' + msg.velocity;
      case 'cc': return 'ch' + msg.channel + ' cc' + msg.cc + ' = ' + msg.value;
      case 'program': return 'ch' + msg.channel + ' program ' + msg.program;
      case 'pitchbend': return 'ch' + msg.channel + ' bend ' + msg.value;
      case 'sysex': return 'sysex [' + msg.raw.length + ' bytes]';
      default: return msg.type;
    }
  }

  function logLine(entry) {
    var li = document.createElement('li');
    var ctl = entry.control;
    var label = ctl ? (ctl.kind + (ctl.name ? ':' + ctl.name : ' ' + (ctl.index + 1))) : '';
    li.textContent = (entry.dir === 'in' ? '← ' : '→ ') + entry.port + '  ' + describe(entry.msg) + (label ? '  [' + label + ']' : '') + (entry.forwarded ? '  (fwd)' : '');
    li.className = entry.dir;
    els.log.insertBefore(li, els.log.firstChild);
    while (els.log.childNodes.length > 200) els.log.removeChild(els.log.lastChild);
  }

  function onEvent(entry) {
    logLine(entry);
    var c = entry.control;
    if (!c) return;
    if (c.kind === 'pad' && c.down) flash(padEls[c.index]);
    else if (c.kind === 'knob' && knobEls[c.index]) knobEls[c.index].value = c.value;
    else if (c.kind === 'transport') flash(transportEls[c.name]);
  }

  function refreshPorts() {
    var inputs = hub.inputs(), outputs = hub.outputs();
    els.input.textContent = '';
    if (!inputs.length) {
      var none = document.createElement('li');
      none.textContent = 'No MIDI inputs detected';
      els.input.appendChild(none);
    }
    inputs.forEach(function (p) {
      var li = document.createElement('li');
      li.textContent = (p.name || 'Unnamed input') + (p.state === 'disconnected' ? ' (disconnected)' : '');
      els.input.appendChild(li);
    });

    var previous = els.output.value;
    els.output.textContent = '';
    var blank = document.createElement('option');
    blank.value = ''; blank.textContent = outputs.length ? '— select output —' : 'No MIDI outputs detected';
    els.output.appendChild(blank);
    outputs.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id; o.textContent = p.name || 'Unnamed output';
      els.output.appendChild(o);
    });
    var keep = outputs.some(function (p) { return p.id === previous; });
    if (!keep) {
      // Prefer an FM-1 if one is present; otherwise leave unselected.
      var fm = outputs.filter(function (p) { return /fm-?1/i.test(p.name || ''); })[0];
      previous = fm ? fm.id : '';
    }
    els.output.value = previous;
    hub.setOutput(previous || null);
    var ready = !!previous;
    [els.test, els.panic, els.sendProgram].forEach(function (b) { b.disabled = !ready; });
    setStatus(inputs.length + ' input(s), ' + outputs.length + ' output(s)' + (ready ? '' : ' — choose an output to enable sound tests'), ready ? 'ok' : 'warn');
  }

  /* ---------- learn mode ---------- */

  function beginLearn(slot, label) {
    hub.learn(slot);
    els.learnState.textContent = 'Move or press the control for ' + label + '…';
    els.learnReset.hidden = false;
  }

  /* ---------- actions ---------- */

  function guarded(fn) {
    return function () {
      try { fn.apply(null, arguments); }
      catch (err) { setStatus(err.message, 'error'); }
    };
  }
  function channel() {
    var c = parseInt(els.channel.value, 10);
    return c >= 1 && c <= 16 ? c : 1;
  }

  async function connect() {
    if (!navigator.requestMIDIAccess) {
      setStatus('Web MIDI is not available in this browser. Use Chrome or Edge over HTTPS.', 'error');
      return;
    }
    els.connect.disabled = true;
    setStatus('Requesting MIDI access…', '');
    try {
      var access = await navigator.requestMIDIAccess({ sysex: els.sysex.checked });
      hub = MidiCore.createHub(access, {
        profile: loadProfile() || MidiCore.getProfile('smc-pad'),
        onEvent: onEvent,
        onError: function (e) { setStatus(e.reason + (e.port ? ' (' + e.port + ')' : ''), 'warn'); },
        onStateChange: function () { refreshPorts(); },
        onLearned: function (l) {
          saveProfile(l.profile);
          els.learnState.textContent = 'Bound ' + (l.slot.kind === 'transport' ? l.slot.name : l.slot.kind + ' ' + (l.slot.index + 1)) + '.';
          els.learnReset.hidden = false;
        }
      });
      hub.start();
      refreshPorts();
      els.connect.textContent = 'Connected';
      [els.forward, els.clear, els.download].forEach(function (b) { b.disabled = false; });
    } catch (err) {
      els.connect.disabled = false;
      setStatus('MIDI access failed: ' + (err && err.message ? err.message : err), 'error');
    }
  }

  function wire() {
    buildSurface();
    els.connect.addEventListener('click', connect);

    els.output.addEventListener('change', guarded(function () {
      hub.setOutput(els.output.value || null);
      var ready = !!els.output.value;
      [els.test, els.panic, els.sendProgram].forEach(function (b) { b.disabled = !ready; });
    }));
    els.forward.addEventListener('change', function () { hub.setForward(els.forward.checked); });

    els.test.addEventListener('click', guarded(function () {
      setStatus('Sound test: C4 for 400 ms on channel ' + channel(), 'ok');
      hub.soundTest(channel(), 60).catch(function (e) { setStatus(e.message, 'error'); });
    }));
    els.panic.addEventListener('click', guarded(function () { hub.panic(channel()); }));
    els.sendProgram.addEventListener('click', guarded(function () {
      var n = parseInt(els.program.value, 10);
      hub.send(MidiCore.encode.program(channel(), n));
    }));

    els.pads.addEventListener('click', guarded(function (ev) {
      var btn = ev.target.closest('.fm1-pad');
      if (!btn || !hub) return;
      var i = parseInt(btn.dataset.index, 10);
      if (ev.shiftKey) return beginLearn({ kind: 'pad', index: i }, 'pad ' + (i + 1));
      var note = hub.getProfile().pads[i];
      hub.send(MidiCore.encode.noteOn(channel(), note, 100));
      window.setTimeout(guarded(function () { hub.send(MidiCore.encode.noteOff(channel(), note, 0)); }), 200);
    }));
    els.knobs.addEventListener('click', function (ev) {
      var m = ev.target.closest('meter');
      if (m && ev.shiftKey && hub) beginLearn({ kind: 'knob', index: parseInt(m.dataset.index, 10) }, 'knob ' + (parseInt(m.dataset.index, 10) + 1));
    });
    els.transport.addEventListener('click', function (ev) {
      var b = ev.target.closest('.fm1-transport-btn');
      if (b && ev.shiftKey && hub && b.dataset.name !== 'continue') beginLearn({ kind: 'transport', name: b.dataset.name }, b.dataset.name);
    });

    els.learnReset.addEventListener('click', function () {
      if (hub) { hub.cancelLearn(); hub.setProfile(MidiCore.getProfile('smc-pad')); }
      storage(function (s) { s.removeItem(PROFILE_KEY); });
      els.learnState.textContent = 'Mapping reset to defaults.';
      els.learnReset.hidden = true;
    });

    els.clear.addEventListener('click', function () { if (hub) hub.journal.clear(); els.log.textContent = ''; });
    els.download.addEventListener('click', function () {
      if (!hub) return;
      var blob = new Blob([hub.journal.toNDJSON()], { type: 'application/x-ndjson' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'fm1-session-' + new Date().toISOString().replace(/[:.]/g, '-') + '.ndjson';
      document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
  }

  if (!window.MidiCore) { setStatus('midi-core.js failed to load', 'error'); return; }
  wire();
  setStatus(navigator.requestMIDIAccess ? 'Ready — click Connect' : 'Web MIDI unavailable in this browser (use Chrome/Edge over HTTPS)', navigator.requestMIDIAccess ? '' : 'error');
})();

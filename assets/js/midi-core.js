/*
 * midi-core.js — device-agnostic Web MIDI toolkit (no DOM access).
 *
 * Loads as a browser global (`window.MidiCore`) or a CommonJS module, so the
 * same code is exercised by the Node smoke tests in tests/.
 *
 * Contents
 *   1. Message parsing / encoding
 *   2. Device profiles (FM-1, M-Vave SMC-Pad) + control classification
 *   3. Event journal (bounded, NDJSON-exportable)
 *   4. Hub: ports -> parse -> classify -> journal -> optional forward
 *
 * Profile defaults for the SMC-Pad are ASSUMPTIONS, not vendor documentation.
 * Use the hub's learn mode to bind the real controls of a given unit.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MidiCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. Parsing / encoding
   * ------------------------------------------------------------------ */

  var CHANNEL_TYPES = {
    0x80: 'noteoff', 0x90: 'noteon', 0xA0: 'polyaftertouch', 0xB0: 'cc',
    0xC0: 'program', 0xD0: 'channelaftertouch', 0xE0: 'pitchbend'
  };
  var REALTIME_TYPES = {
    0xF8: 'clock', 0xFA: 'start', 0xFB: 'continue', 0xFC: 'stop',
    0xFE: 'activesensing', 0xFF: 'reset'
  };
  var MMC_COMMANDS = {
    0x01: 'stop', 0x02: 'play', 0x03: 'play', 0x04: 'fast-forward',
    0x05: 'rewind', 0x06: 'record', 0x07: 'record', 0x09: 'pause'
  };

  function isData(b) { return Number.isInteger(b) && b >= 0 && b <= 0x7F; }

  /** Parse one complete Web MIDI message. Returns null if malformed. */
  function parseMessage(data) {
    if (!data || data.length === 0) return null;
    var bytes = Array.prototype.slice.call(data);
    var status = bytes[0];
    if (!Number.isInteger(status) || status < 0x80 || status > 0xFF) return null;
    var base = { raw: bytes };

    if (status === 0xF0) {
      if (bytes[bytes.length - 1] !== 0xF7) return null;
      return Object.assign(base, { type: 'sysex' });
    }
    if (status >= 0xF8) {
      var rt = REALTIME_TYPES[status];
      return rt && bytes.length === 1 ? Object.assign(base, { type: rt }) : null;
    }
    if (status >= 0xF1) return Object.assign(base, { type: 'system' });

    var kind = status & 0xF0;
    var type = CHANNEL_TYPES[kind];
    var needed = (kind === 0xC0 || kind === 0xD0) ? 2 : 3;
    if (bytes.length !== needed || !bytes.slice(1).every(isData)) return null;
    var msg = Object.assign(base, { type: type, channel: (status & 0x0F) + 1 });

    switch (kind) {
      case 0x80: msg.note = bytes[1]; msg.velocity = bytes[2]; break;
      case 0x90:
        msg.note = bytes[1]; msg.velocity = bytes[2];
        if (bytes[2] === 0) { msg.type = 'noteoff'; msg.implicitOff = true; }
        break;
      case 0xA0: msg.note = bytes[1]; msg.pressure = bytes[2]; break;
      case 0xB0: msg.cc = bytes[1]; msg.value = bytes[2]; break;
      case 0xC0: msg.program = bytes[1]; break;
      case 0xD0: msg.pressure = bytes[1]; break;
      case 0xE0: msg.value = bytes[1] | (bytes[2] << 7); break; // 0..16383
    }
    return msg;
  }

  function range(name, v, lo, hi) {
    if (!Number.isInteger(v) || v < lo || v > hi) {
      throw new RangeError(name + ' must be an integer in ' + lo + '..' + hi + ', got ' + v);
    }
    return v;
  }
  function chan(c) { return range('channel', c, 1, 16) - 1; }

  var encode = {
    noteOn: function (ch, note, vel) {
      return [0x90 | chan(ch), range('note', note, 0, 127), range('velocity', vel, 1, 127)];
    },
    noteOff: function (ch, note, vel) {
      return [0x80 | chan(ch), range('note', note, 0, 127), range('velocity', vel == null ? 0 : vel, 0, 127)];
    },
    cc: function (ch, cc, value) {
      return [0xB0 | chan(ch), range('cc', cc, 0, 127), range('value', value, 0, 127)];
    },
    program: function (ch, program) {
      return [0xC0 | chan(ch), range('program', program, 0, 127)];
    },
    pitchBend: function (ch, value) {
      range('value', value, 0, 16383);
      return [0xE0 | chan(ch), value & 0x7F, value >> 7];
    },
    allNotesOff: function (ch) { return encode.cc(ch, 123, 0); }
  };

  /* ------------------------------------------------------------------ *
   * 2. Profiles + classification
   * ------------------------------------------------------------------ */

  var TRANSPORT_SLOTS = ['play', 'stop', 'record', 'rewind', 'fast-forward', 'loop', 'pause'];

  function range0(n, fn) { var a = []; for (var i = 0; i < n; i++) a.push(fn(i)); return a; }

  var PROFILES = {
    'smc-pad': {
      id: 'smc-pad',
      label: 'M-Vave SMC-Pad',
      assumed: true, // defaults below are not from vendor documentation
      pads: range0(16, function (i) { return 36 + i; }), // 16 pads: C2..D#3
      knobs: range0(8, function (i) { return 70 + i; }), // 8 knobs: CC 70..77
      transport: { cc: {}, notes: {} } // realtime + MMC always recognised
    },
    'fm-1': {
      id: 'fm-1',
      label: 'FM-1',
      assumed: false,
      pads: [], knobs: [], transport: { cc: {}, notes: {} }
    }
  };

  function cloneProfile(p) { return JSON.parse(JSON.stringify(p)); }
  function getProfile(id) {
    if (!PROFILES[id]) throw new Error('Unknown profile: ' + id);
    return cloneProfile(PROFILES[id]);
  }

  /**
   * Map a parsed message to a control, or null.
   *   {kind:'pad', index, down, velocity} | {kind:'knob', index, value}
   *   | {kind:'transport', name}
   */
  function classify(profile, msg) {
    if (!msg) return null;
    var i;
    switch (msg.type) {
      case 'start': return { kind: 'transport', name: 'play' };
      case 'stop': return { kind: 'transport', name: 'stop' };
      case 'continue': return { kind: 'transport', name: 'continue' };
      case 'sysex':
        // MMC command: F0 7F <device> 06 <command> ... F7
        if (msg.raw.length >= 6 && msg.raw[1] === 0x7F && msg.raw[3] === 0x06 && MMC_COMMANDS[msg.raw[4]]) {
          return { kind: 'transport', name: MMC_COMMANDS[msg.raw[4]] };
        }
        return null;
      case 'cc':
        i = profile.knobs.indexOf(msg.cc);
        if (i >= 0) return { kind: 'knob', index: i, value: msg.value };
        var name = profile.transport.cc[msg.cc];
        return name && msg.value >= 64 ? { kind: 'transport', name: name } : null;
      case 'noteon':
      case 'noteoff':
        i = profile.pads.indexOf(msg.note);
        if (i >= 0) return { kind: 'pad', index: i, down: msg.type === 'noteon', velocity: msg.velocity };
        var tn = profile.transport.notes[msg.note];
        return tn && msg.type === 'noteon' ? { kind: 'transport', name: tn } : null;
      default: return null;
    }
  }

  /**
   * Bind a slot to whatever control produced `msg` (learn mode). Mutates and
   * returns `profile`. Slot: {kind:'pad'|'knob', index} or {kind:'transport', name}.
   */
  function assign(profile, slot, msg) {
    if (!slot || !msg) throw new TypeError('assign needs a slot and a message');
    if (slot.kind === 'pad') {
      if (msg.type !== 'noteon') throw new Error('Pads bind to note-on messages');
      range('pad index', slot.index, 0, Math.max(profile.pads.length, 16) - 1);
      profile.pads[slot.index] = msg.note;
    } else if (slot.kind === 'knob') {
      if (msg.type !== 'cc') throw new Error('Knobs bind to control-change messages');
      range('knob index', slot.index, 0, Math.max(profile.knobs.length, 8) - 1);
      profile.knobs[slot.index] = msg.cc;
    } else if (slot.kind === 'transport') {
      if (TRANSPORT_SLOTS.indexOf(slot.name) < 0) throw new Error('Unknown transport slot: ' + slot.name);
      if (msg.type === 'cc') profile.transport.cc[msg.cc] = slot.name;
      else if (msg.type === 'noteon') profile.transport.notes[msg.note] = slot.name;
      else throw new Error('Transport binds to CC or note-on messages');
    } else {
      throw new Error('Unknown slot kind: ' + slot.kind);
    }
    return profile;
  }

  /* ------------------------------------------------------------------ *
   * 3. Journal
   * ------------------------------------------------------------------ */

  function createJournal(capacity, now) {
    var cap = capacity > 0 ? capacity : 500;
    var clock = now || function () { return Date.now(); };
    var entries = [];
    var seq = 0;
    return {
      push: function (entry) {
        var e = Object.assign({ seq: ++seq, t: clock() }, entry);
        entries.push(e);
        if (entries.length > cap) entries.shift();
        return e;
      },
      snapshot: function () { return entries.slice(); },
      clear: function () { entries.length = 0; },
      size: function () { return entries.length; },
      toNDJSON: function () {
        return entries.map(function (e) {
          var copy = Object.assign({}, e);
          if (copy.msg) copy.msg = Object.assign({}, copy.msg);
          return JSON.stringify(copy);
        }).join('\n') + (entries.length ? '\n' : '');
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * 4. Hub
   * ------------------------------------------------------------------ */

  var FORWARDABLE = { noteon: 1, noteoff: 1, cc: 1, pitchbend: 1, program: 1, polyaftertouch: 1, channelaftertouch: 1 };
  var QUIET = { clock: 1, activesensing: 1 }; // too chatty to journal

  function listPorts(map) {
    var out = [];
    if (map && typeof map.forEach === 'function') map.forEach(function (p) { out.push(p); });
    return out;
  }
  function samePhysical(a, b) {
    return !!a && !!b && a.name === b.name && a.manufacturer === b.manufacturer;
  }

  function createHub(access, opts) {
    if (!access || !access.inputs || !access.outputs) throw new TypeError('createHub needs a MIDIAccess-like object');
    opts = opts || {};
    var journal = opts.journal || createJournal(opts.capacity, opts.now);
    var timers = opts.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var profile = opts.profile ? cloneProfile(opts.profile) : getProfile('smc-pad');
    var outputId = null;
    var forward = false;
    var learning = null;
    var running = false;
    var notify = function (name, arg) { if (typeof opts[name] === 'function') opts[name](arg); };

    function handler(input) {
      return function (ev) { receive(input, ev); };
    }

    function receive(input, ev) {
      var msg = parseMessage(ev && ev.data);
      if (!msg) {
        notify('onError', { port: input.name, reason: 'malformed message', raw: ev && ev.data ? Array.prototype.slice.call(ev.data) : [] });
        return;
      }
      if (QUIET[msg.type]) return;

      if (learning && (msg.type === 'noteon' || msg.type === 'cc') && !(msg.type === 'cc' && msg.value === 0 && learning.kind === 'transport')) {
        var slot = learning;
        try {
          assign(profile, slot, msg);
          learning = null;
          notify('onLearned', { slot: slot, msg: msg, profile: cloneProfile(profile) });
        } catch (err) {
          // Wrong message kind for this slot (e.g. a pad hit while binding a knob): keep waiting.
          notify('onError', { port: input.name, reason: err.message });
        }
        return;
      }

      var entry = journal.push({ dir: 'in', port: input.name, msg: msg, control: classify(profile, msg) });
      notify('onEvent', entry);

      if (forward && outputId && FORWARDABLE[msg.type]) {
        var out = access.outputs.get(outputId);
        if (out && !samePhysical(out, input)) {
          out.send(msg.raw);
          journal.push({ dir: 'out', port: out.name, msg: parseMessage(msg.raw), forwarded: true });
        }
      }
    }

    function attach() {
      listPorts(access.inputs).forEach(function (input) { input.onmidimessage = handler(input); });
    }
    function detach() {
      listPorts(access.inputs).forEach(function (input) { input.onmidimessage = null; });
    }

    function send(bytes) {
      var out = outputId ? access.outputs.get(outputId) : null;
      if (!out) throw new Error('No MIDI output selected');
      var msg = parseMessage(bytes);
      if (!msg) throw new Error('Refusing to send malformed MIDI message');
      out.send(bytes);
      return journal.push({ dir: 'out', port: out.name, msg: msg });
    }

    return {
      journal: journal,
      start: function () {
        running = true;
        attach();
        access.onstatechange = function (ev) {
          if (running) attach(); // hot-plug: rebind new inputs
          notify('onStateChange', ev);
        };
      },
      stop: function () { running = false; detach(); access.onstatechange = null; },
      inputs: function () { return listPorts(access.inputs); },
      outputs: function () { return listPorts(access.outputs); },
      setOutput: function (id) {
        if (id && !access.outputs.get(id)) throw new Error('Unknown output: ' + id);
        outputId = id || null;
      },
      getOutput: function () { return outputId; },
      setForward: function (on) { forward = !!on; },
      getProfile: function () { return cloneProfile(profile); },
      setProfile: function (p) { profile = cloneProfile(p); },
      learn: function (slot) { learning = slot; },
      cancelLearn: function () { learning = null; },
      isLearning: function () { return learning; },
      send: send,
      /** Smoke test: short middle-C note to the selected output. */
      soundTest: function (channel, note) {
        var ch = channel || 1, n = note == null ? 60 : note;
        send(encode.noteOn(ch, n, 100));
        return new Promise(function (resolve) {
          timers(function () { resolve(send(encode.noteOff(ch, n, 0))); }, 400);
        });
      },
      panic: function (channel) { return send(encode.allNotesOff(channel || 1)); }
    };
  }

  return {
    parseMessage: parseMessage, encode: encode,
    PROFILES: PROFILES, TRANSPORT_SLOTS: TRANSPORT_SLOTS,
    getProfile: getProfile, classify: classify, assign: assign,
    createJournal: createJournal, createHub: createHub
  };
}));

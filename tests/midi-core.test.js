'use strict';
// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../assets/js/midi-core.js');

/* ---------- fakes ---------- */

function fakeInput(id, name) {
  return { id: id, name: name, manufacturer: 'Test', onmidimessage: null,
    emit: function (bytes) { this.onmidimessage({ data: Uint8Array.from(bytes) }); } };
}
function fakeOutput(id, name) {
  return { id: id, name: name, manufacturer: 'Test', sent: [], send: function (b) { this.sent.push(Array.from(b)); } };
}
function fakeAccess(inputs, outputs) {
  return {
    inputs: new Map(inputs.map(function (p) { return [p.id, p]; })),
    outputs: new Map(outputs.map(function (p) { return [p.id, p]; })),
    onstatechange: null
  };
}

/* ---------- parsing ---------- */

test('parses note on/off, incl. velocity-0 note-on as note-off', () => {
  assert.deepEqual(pick(M.parseMessage([0x90, 60, 100]), ['type', 'channel', 'note', 'velocity']),
    { type: 'noteon', channel: 1, note: 60, velocity: 100 });
  const off = M.parseMessage([0x93, 60, 0]);
  assert.equal(off.type, 'noteoff');
  assert.equal(off.implicitOff, true);
  assert.equal(off.channel, 4);
});

test('parses cc, program, pitch bend', () => {
  assert.equal(M.parseMessage([0xB0, 74, 99]).value, 99);
  assert.equal(M.parseMessage([0xC1, 70]).program, 70);
  assert.equal(M.parseMessage([0xE0, 0x00, 0x40]).value, 8192); // centre
  assert.equal(M.parseMessage([0xE0, 0x7F, 0x7F]).value, 16383);
});

test('parses realtime and sysex; rejects malformed input', () => {
  assert.equal(M.parseMessage([0xFA]).type, 'start');
  assert.equal(M.parseMessage([0xFC]).type, 'stop');
  assert.equal(M.parseMessage([0xF0, 0x7F, 0x7F, 0x06, 0x02, 0xF7]).type, 'sysex');
  for (const bad of [[], null, [0x40, 1, 2], [0x90, 60], [0x90, 60, 200], [0xC0], [0xF0, 1, 2], [0xF9]]) {
    assert.equal(M.parseMessage(bad), null, JSON.stringify(bad));
  }
});

test('encoders produce valid bytes and reject out-of-range values', () => {
  assert.deepEqual(M.encode.noteOn(1, 60, 100), [0x90, 60, 100]);
  assert.deepEqual(M.encode.noteOff(16, 60), [0x8F, 60, 0]);
  assert.deepEqual(M.encode.cc(2, 7, 127), [0xB1, 7, 127]);
  assert.deepEqual(M.encode.program(1, 71), [0xC0, 71]);
  assert.deepEqual(M.encode.pitchBend(1, 8192), [0xE0, 0, 64]);
  assert.throws(() => M.encode.noteOn(0, 60, 100), RangeError);
  assert.throws(() => M.encode.noteOn(1, 128, 100), RangeError);
  assert.throws(() => M.encode.noteOn(1, 60, 0), RangeError); // vel 0 would be a note-off
  assert.throws(() => M.encode.cc(1, 1, -1), RangeError);
});

test('encode -> parse round-trips', () => {
  const m = M.parseMessage(M.encode.cc(5, 74, 33));
  assert.deepEqual(pick(m, ['type', 'channel', 'cc', 'value']), { type: 'cc', channel: 5, cc: 74, value: 33 });
});

/* ---------- profiles / classification ---------- */

test('SMC-Pad profile: 16 pads, 8 knobs, marked as assumed', () => {
  const p = M.getProfile('smc-pad');
  assert.equal(p.pads.length, 16);
  assert.equal(p.knobs.length, 8);
  assert.equal(p.assumed, true);
  assert.equal(new Set(p.pads).size, 16);
  assert.equal(new Set(p.knobs).size, 8);
});

test('getProfile returns independent copies; unknown id throws', () => {
  const a = M.getProfile('smc-pad'); a.pads[0] = 1;
  assert.equal(M.getProfile('smc-pad').pads[0], 36);
  assert.throws(() => M.getProfile('nope'));
});

test('classifies pads, knobs, and ignores unmapped input', () => {
  const p = M.getProfile('smc-pad');
  assert.deepEqual(M.classify(p, M.parseMessage([0x99, 39, 90])), { kind: 'pad', index: 3, down: true, velocity: 90 });
  assert.equal(M.classify(p, M.parseMessage([0x89, 39, 0])).down, false);
  assert.deepEqual(M.classify(p, M.parseMessage([0xB0, 72, 64])), { kind: 'knob', index: 2, value: 64 });
  assert.equal(M.classify(p, M.parseMessage([0x90, 10, 90])), null);
  assert.equal(M.classify(p, M.parseMessage([0xB0, 1, 90])), null);
});

test('extended transport: realtime and MMC are recognised without configuration', () => {
  const p = M.getProfile('smc-pad');
  const name = (b) => M.classify(p, M.parseMessage(b)).name;
  assert.equal(name([0xFA]), 'play');
  assert.equal(name([0xFC]), 'stop');
  assert.equal(name([0xFB]), 'continue');
  assert.equal(name([0xF0, 0x7F, 0x7F, 0x06, 0x01, 0xF7]), 'stop');
  assert.equal(name([0xF0, 0x7F, 0x7F, 0x06, 0x02, 0xF7]), 'play');
  assert.equal(name([0xF0, 0x7F, 0x7F, 0x06, 0x04, 0xF7]), 'fast-forward');
  assert.equal(name([0xF0, 0x7F, 0x7F, 0x06, 0x05, 0xF7]), 'rewind');
  assert.equal(name([0xF0, 0x7F, 0x7F, 0x06, 0x06, 0xF7]), 'record');
  assert.equal(M.classify(p, M.parseMessage([0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7])), null); // not MMC
});

test('assign binds CC/note transport; CC release (value<64) is ignored', () => {
  const p = M.getProfile('smc-pad');
  M.assign(p, { kind: 'transport', name: 'record' }, M.parseMessage([0xB0, 118, 127]));
  M.assign(p, { kind: 'transport', name: 'loop' }, M.parseMessage([0x90, 20, 100]));
  assert.equal(M.classify(p, M.parseMessage([0xB0, 118, 127])).name, 'record');
  assert.equal(M.classify(p, M.parseMessage([0xB0, 118, 0])), null);
  assert.equal(M.classify(p, M.parseMessage([0x90, 20, 100])).name, 'loop');
});

test('assign validates slot/message pairing', () => {
  const p = M.getProfile('smc-pad');
  assert.throws(() => M.assign(p, { kind: 'knob', index: 0 }, M.parseMessage([0x90, 60, 90])));
  assert.throws(() => M.assign(p, { kind: 'pad', index: 0 }, M.parseMessage([0xB0, 1, 1])));
  assert.throws(() => M.assign(p, { kind: 'pad', index: 99 }, M.parseMessage([0x90, 60, 90])), RangeError);
  assert.throws(() => M.assign(p, { kind: 'transport', name: 'warp' }, M.parseMessage([0xB0, 1, 127])));
});

/* ---------- journal ---------- */

test('journal is bounded, ordered, and exports NDJSON', () => {
  let t = 0;
  const j = M.createJournal(3, () => ++t);
  for (let i = 0; i < 5; i++) j.push({ dir: 'in', n: i });
  const s = j.snapshot();
  assert.deepEqual(s.map((e) => e.n), [2, 3, 4]);
  assert.deepEqual(s.map((e) => e.seq), [3, 4, 5]);
  const lines = j.toNDJSON().trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 3);
  j.clear();
  assert.equal(j.toNDJSON(), '');
});

/* ---------- hub smoke tests ---------- */

function rig() {
  const pad = fakeInput('in-pad', 'SMC-Pad');
  const fmIn = fakeInput('in-fm1', 'FM-1');
  const fmOut = fakeOutput('out-fm1', 'FM-1');
  const events = [], errors = [];
  const hub = M.createHub(fakeAccess([pad, fmIn], [fmOut]), {
    onEvent: (e) => events.push(e), onError: (e) => errors.push(e),
    setTimeout: (fn) => fn() // run timers synchronously
  });
  hub.start();
  return { pad, fmIn, fmOut, hub, events, errors };
}

test('hub: inputs are classified and journaled; clock is not journaled', () => {
  const r = rig();
  r.pad.emit([0x99, 36, 100]);
  r.pad.emit([0xB0, 70, 10]);
  r.pad.emit([0xF8]);
  assert.equal(r.hub.journal.size(), 2);
  assert.equal(r.events[0].control.kind, 'pad');
  assert.equal(r.events[1].control.kind, 'knob');
});

test('hub: malformed input is reported, never journaled', () => {
  const r = rig();
  r.pad.emit([0x90, 60]);
  assert.equal(r.errors.length, 1);
  assert.equal(r.hub.journal.size(), 0);
});

test('hub: sound test sends note-on then note-off to the selected output', async () => {
  const r = rig();
  assert.throws(() => r.hub.send([0x90, 60, 100]), /No MIDI output/);
  r.hub.setOutput('out-fm1');
  await r.hub.soundTest(1, 60);
  assert.deepEqual(r.fmOut.sent, [[0x90, 60, 100], [0x80, 60, 0]]);
  assert.equal(r.hub.journal.snapshot().filter((e) => e.dir === 'out').length, 2);
});

test('hub: send refuses malformed bytes and unknown outputs', () => {
  const r = rig();
  assert.throws(() => r.hub.setOutput('missing'));
  r.hub.setOutput('out-fm1');
  assert.throws(() => r.hub.send([0x90, 60]), /malformed/);
  assert.equal(r.fmOut.sent.length, 0);
});

test('hub: SMC-Pad -> FM-1 forwarding only when enabled, never transport/sysex/clock', () => {
  const r = rig();
  r.hub.setOutput('out-fm1');
  r.pad.emit([0x90, 36, 90]);
  assert.equal(r.fmOut.sent.length, 0);
  r.hub.setForward(true);
  r.pad.emit([0x90, 36, 90]);
  r.pad.emit([0xFA]);
  r.pad.emit([0xF0, 0x7F, 0x7F, 0x06, 0x02, 0xF7]);
  assert.deepEqual(r.fmOut.sent, [[0x90, 36, 90]]);
});

test('hub: does not forward into the same physical device (feedback guard)', () => {
  const loopIn = fakeInput('in-x', 'FM-1');
  const loopOut = fakeOutput('out-x', 'FM-1');
  const hub = M.createHub(fakeAccess([loopIn], [loopOut]));
  hub.start(); hub.setOutput('out-x'); hub.setForward(true);
  loopIn.emit([0x90, 60, 90]);
  assert.equal(loopOut.sent.length, 0);
});

test('hub: learn mode binds the next matching control and then stops learning', () => {
  const r = rig();
  const learned = [];
  const hub = M.createHub(fakeAccess([r.pad], []), { onLearned: (l) => learned.push(l) });
  hub.start();
  hub.learn({ kind: 'knob', index: 0 });
  r.pad.emit([0x90, 40, 100]); // wrong kind: ignored, keeps waiting
  assert.ok(hub.isLearning());
  r.pad.emit([0xB0, 21, 50]);
  assert.equal(hub.isLearning(), null);
  assert.equal(hub.getProfile().knobs[0], 21);
  assert.equal(learned.length, 1);
  r.pad.emit([0xB0, 21, 80]);
  assert.equal(hub.journal.snapshot().pop().control.kind, 'knob');
});

test('hub: hot-plug rebinding and stop() detaches handlers', () => {
  const pad = fakeInput('in-pad', 'SMC-Pad');
  const access = fakeAccess([pad], []);
  const hub = M.createHub(access);
  hub.start();
  const late = fakeInput('in-late', 'Late');
  access.inputs.set(late.id, late);
  access.onstatechange({ port: late });
  late.emit([0x90, 36, 90]);
  assert.equal(hub.journal.size(), 1);
  hub.stop();
  assert.equal(pad.onmidimessage, null);
  assert.equal(access.onstatechange, null);
});

test('hub: panic sends All Notes Off', () => {
  const r = rig();
  r.hub.setOutput('out-fm1');
  r.hub.panic(3);
  assert.deepEqual(r.fmOut.sent, [[0xB2, 123, 0]]);
});

function pick(o, keys) { const r = {}; keys.forEach((k) => { r[k] = o[k]; }); return r; }

---
layout: default
title: FM-1 Console
permalink: /fm1/
---

Direct Web MIDI console for the **FM-1** and the **M-Vave SMC-Pad** (16 pads, 8 knobs, extended transport). Needs Chrome or Edge; MIDI stays in the browser and nothing is uploaded.

<style>
  #fm1 [data-kind="ok"] { color: #2e7d32; }
  #fm1 [data-kind="warn"] { color: #b26a00; }
  #fm1 [data-kind="error"] { color: #b3261e; }
  #fm1 .fm1-row { display: flex; flex-wrap: wrap; gap: .6rem 1rem; align-items: center; margin: .8rem 0; }
  #fm1 fieldset { border: 1px solid rgba(128,128,128,.4); margin: 1rem 0; padding: .6rem .9rem; }
  #fm1 legend { padding: 0 .4rem; }
  #fm1 button { font: inherit; cursor: pointer; }
  #fm1 button:disabled { cursor: not-allowed; opacity: .5; }
  #fm1-pads { display: grid; grid-template-columns: repeat(4, minmax(3rem, 1fr)); gap: .4rem; max-width: 22rem; }
  .fm1-pad { aspect-ratio: 1; border: 1px solid rgba(128,128,128,.6); border-radius: 6px; background: rgba(128,128,128,.12); }
  .fm1-pad.on, .fm1-transport-btn.on { background: #e0a030; color: #000; }
  #fm1-knobs { display: grid; grid-template-columns: repeat(4, 1fr); gap: .6rem; max-width: 26rem; }
  .fm1-knob { display: flex; flex-direction: column; gap: .15rem; font-size: .8rem; }
  .fm1-knob meter { width: 100%; }
  #fm1-transport { display: flex; flex-wrap: wrap; gap: .4rem; }
  #fm1-log { list-style: none; margin: 0; padding: 0; max-height: 16rem; overflow: auto; font-size: .8rem; }
  #fm1-log .out { opacity: .75; }
  @media (max-width: 480px) { #fm1-knobs { grid-template-columns: repeat(2, 1fr); } }
</style>

<div id="fm1">

<div class="fm1-row">
  <button id="fm1-connect" type="button">Connect MIDI</button>
  <label><input id="fm1-sysex" type="checkbox"> Enable SysEx (needed for MMC transport)</label>
  <span id="fm1-status" role="status" aria-live="polite"></span>
</div>

<fieldset>
  <legend>Ports</legend>
  <p><strong>Inputs</strong></p>
  <ul id="fm1-input-list"><li>Not connected</li></ul>
  <div class="fm1-row">
    <label>Output <select id="fm1-output"><option value="">— connect first —</option></select></label>
    <label>Channel <input id="fm1-channel" type="number" min="1" max="16" value="1" style="width:4rem"></label>
    <label><input id="fm1-forward" type="checkbox" disabled> Route SMC-Pad → output</label>
  </div>
</fieldset>

<fieldset>
  <legend>Smoke test</legend>
  <div class="fm1-row">
    <button id="fm1-test" type="button" disabled>Sound test (C4)</button>
    <button id="fm1-panic" type="button" disabled>All notes off</button>
    <label>Program <input id="fm1-program" type="number" min="0" max="127" value="0" style="width:4.5rem"></label>
    <button id="fm1-send-program" type="button" disabled>Send</button>
  </div>
</fieldset>

<fieldset>
  <legend>SMC-Pad surface</legend>
  <div id="fm1-pads"></div>
  <p><strong>Knobs</strong></p>
  <div id="fm1-knobs"></div>
  <p><strong>Transport</strong></p>
  <div id="fm1-transport"></div>
  <p><small>Default note/CC numbers are assumptions, not vendor data. Shift-click a pad, knob or transport button, then press the matching control on the hardware to bind it. Bindings persist in this browser.</small></p>
  <div class="fm1-row">
    <span id="fm1-learn-state"></span>
    <button id="fm1-learn-reset" type="button" hidden>Reset mapping</button>
  </div>
</fieldset>

<fieldset>
  <legend>Event journal</legend>
  <div class="fm1-row">
    <button id="fm1-clear" type="button" disabled>Clear</button>
    <button id="fm1-download" type="button" disabled>Download NDJSON</button>
  </div>
  <ol id="fm1-log" reversed></ol>
</fieldset>

</div>

<script src="{{ '/assets/js/midi-core.js' | relative_url }}"></script>
<script src="{{ '/assets/js/fm1-console.js' | relative_url }}"></script>

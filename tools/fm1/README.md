# FM-1 tooling

## Status

| Item | State |
|------|-------|
| Swift bridge build (`SwiftShims`) | Not reproducible here: the bridge is not in this repo and this container is Linux. Run the diagnostic on the Mac. |
| Browser console (`/fm1/`) | Implemented; Node smoke tests pass. Not yet exercised against real FM-1 / SMC-Pad hardware. |
| SMC-Pad note/CC defaults | **Assumptions**, not vendor data. Bind real controls with learn mode (shift-click a control, then press it). |
| FM-1 arpeggiator / preset parameters | Not mapped. Needs the FM-1 MIDI implementation chart. |
| Firmware flashing | Out of scope; keep isolated from the performance path. |

## 1. Diagnose the Swift build (on the Mac)

```bash
tools/fm1/fm1-diagnose.sh /path/to/swift/project
```

Produces `fm1-diagnose.log` and `build.log` in the project directory. Paste
`fm1-diagnose.log` back into the session. Exit status: `0` build ok, `1` build
failed, `2` bad usage or not macOS.

Likely causes, in order: compiler/SDK mismatch (a non-Xcode `swift` first on
`PATH`, or `TOOLCHAINS`/`SDKROOT` overrides), stale module cache, Xcode first
launch or licence pending, damaged Command Line Tools.

## 2. Browser console

Serve the site (`bundle exec jekyll serve`) and open `/pigments-lab/fm1/` in
Chrome or Edge. Web MIDI requires a secure context (`localhost` counts).

Smoke-test checklist with hardware attached:

1. Connect MIDI; both devices appear under Ports.
2. Select the FM-1 output; **Sound test** is audible.
3. Hit each of the 16 pads, turn each of the 8 knobs, press each transport
   button; journal lines appear and the surface lights up.
4. Enable **Route SMC-Pad → output**; pads now sound the FM-1.
5. **Download NDJSON** yields one JSON object per line.

## 3. Automated tests

```bash
node --test tests/midi-core.test.js
```

Covers parsing, encoders, classification, MMC/realtime transport, learn mode,
journal bounds, hub routing, forwarding guards and hot-plug, using a fake
`MIDIAccess` (no hardware needed).

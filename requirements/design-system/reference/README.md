# FortyMM design system: reference

The reference the app's screenshot tests (Playwright) are checked against. These are the boards of the "FortyMM component showcase" canvas (https://claude.ai/artifact/PBhAjZkms9C8S1FQ6YbM1H), pulled 2026-11-26: every component of the v2.1 library in its documented states. Overlays, open menus and forced hover, focus and pressed states are drawn in place, so each can be captured without interaction. `data-testid` values name each target.

| File | Board |
| --- | --- |
| `Main.dc.html` | 01 Foundations |
| `Roles.dc.html` | 02 Roles and buttons |
| `Forms.dc.html` | 03 Fields, choices and selection |
| `Containers.dc.html` | 04 Containers and feedback |
| `Overlays.dc.html` | 05 Overlays |
| `Match.dc.html` | 06 Match components |
| `More.dc.html` | 07 More components |
| `States.dc.html` | 08 State matrix |
| `canvas.json` | The canvas layout index (board order, sizes and titles) |
| `ds/fortymm/` | The design system copy the boards are built from: tokens, fonts, `kit.css` (the `fm-*` component classes) |
| `support.js` | The canvas editor's runtime (`artifact-type/dc-runtime.js` of the canvas artifact) |

A `.dc.html` is a canvas-editor artboard: markup under `<x-dc>`, `{{...}}` holes filled from the `renderVals()` data in its `<script type="text/x-dc">`, by `support.js`. Open them through the server, not as files: `./bin/mise run requirements:design-system:reference:serve`.

## Local changes

Where the boards disagree with a standard the app follows, our copy is changed to the standard:

- `Forms.dc.html`, date picker: the field reads "Saturday, 11 April 2026", the browser's own British English long date (`Intl.DateTimeFormat('en-GB', { dateStyle: 'full' })`), not the canvas's "Saturday 11 April 2026". The app writes dates in the user's locale; the showcase pins British English.

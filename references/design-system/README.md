# FortyMM design system: reference sheet

Reference only. Nothing here ships or runs in the app. These are the boards of the "FortyMM reference sheet" canvas (https://claude.ai/artifact/28UegPF5kB3KnssPGoscWf), exported 2026-11-14, made from the design system artifact (https://claude.ai/artifact/JRzfvUpavyG2qR4nWUrWoA, v2.1). The app's `/design-system` page is checked against them.

| File | Board |
| --- | --- |
| `Main.dc.html` | Colour |
| `Typography.dc.html` | Type |
| `Foundations.dc.html` | Spacing, radii, shadows, icons |
| `Controls.dc.html` | Controls: state matrix |
| `Feedback.dc.html` | Containers, feedback, overlays |
| `Match.dc.html` | Match, scoring, schedule |
| `reference.css` | The canvas's shared stylesheet (the `ref-*` sheet layout classes and the `fm-*` component classes the boards use). Uploaded asset `9f72ae45fcd4326d7bab39a709ac4598` of the canvas. |
| `canvas.json` | The canvas layout index (board sizes and titles) |

Reading them: a `.dc.html` is a canvas-editor artboard, not a plain page. Markup is under `<x-dc>`; `<sc-for list="{{x}}">` repeats from the `renderVals()` data in its `<script type="text/x-dc">`; `{{...}}` are holes. They need the editor's `support.js` runtime to render, which isn't here, so read them as markup and CSS specs, not as pages to open. `data-testid` values (e.g. `color-ink-950`, `role-card`) name each target.

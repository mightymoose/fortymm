# Component library (v2.1)

- `kit.css` — every `fm-*` class: buttons, fields, choice controls, selection, cards, notices, alerts, toasts, tooltips, overlays, match row, score entry, game history, schedule blocks, rest. Tokens only.
- `kit.js` — shared behaviour (`window.FM`): icons (`data-icon`), tooltips (`data-tip`, hover + focus, Esc), single-select groups (`data-select="single"` on radiogroup/tablist/pressed), filter chips with exclusive `data-all`, switches, disclosures, dialogs (`data-dialog`, `data-close`, backdrop), toasts (`FM.toast`), split handle, score entry, live announcements.
- Also in `kit.js`: code input (`data-code`), command palette (`FM.palette`), menubar (`role=menubar`), carousel (`.fm-carousel`), sheets (`<dialog class="fm-sheet">`, `--bottom`), combobox, date picker.
- Demo rules: `data-undo` needs a reversible effect (`data-done-label`, `data-hide`, `data-reveal`) or no Undo is shown; `data-demo` marks a button that would need a server.
- `match.js` — shared match renderers + sample day (`window.FMMatch`): `row`, `games`, `slot`, `timeline`, `detail`.
- `index.html` — gallery. Static, non-functional examples are marked "Visual only".
- `states.html` — state matrix.
- `TESTING.md` — Playwright screenshot setup: `?test`, `?only=<testid>`, ready signal, helpers, test ids.

Load order: `colors_and_type.css`, `kit.css`, then `match.js`, `kit.js` at the end of body.

# FortyMM Design System (v2.1)

FortyMM is a free table-tennis app for players and organizers: score matches at the table, run tournaments across every table in a venue, follow draws and ratings. The name comes from the 40mm ball.

Surfaces: mobile app (scoring, a player's tournament day), web tournament admin, public spectator bracket, marketing site.

**v2 goal:** dependable club equipment. Practical, welcoming, precise, readable mid-rally. Everything on screen must have a job; match information comes first. See `Before and after.html` for the changes.

---

## Principles

1. **Match information first.** Names, scores, match status, table and next action are the loudest things on any screen. Chrome, labels and decoration step back.
2. **Every accent has a job.** If a colour isn't telling you something (action, selection, status), it's grey.
3. **One signal per element.** A live match shows one red "Live" marker. Not a green border, a glow, a coloured name, a coloured score and a coloured avatar.
4. **Motion is feedback.** Things move only right after you do something, then stop.
5. **Say it plainly.** Lead with what people can do. State commitments once, as facts.

---

## Colour

Dark only. Flat surfaces. No gradients, glows, textures or halos — there are no tokens for them.

**Surfaces** — `--bg-app` (ink-950) for the page, `--bg-panel` (ink-900) for sidebars and grouped content, `--bg-hover` (ink-700) for hover/pressed. Most screens use two surfaces.

**Text** — `--fg-1` names, scores, headings · `--fg-2` body · `--fg-3` metadata and the losing side · `--fg-placeholder` placeholders only. All ≥ 4.5:1 on ink-950.

**Orange (`--accent`) = actions and selection. Nothing else.**
- Primary buttons, focus ring (`--focus-ring`), links.
- Selected tab / nav item / filter chip: `--accent-soft` background with `--accent-text`.
- Never for status, winners, names, scores, ratings, borders on cards, section headings or bullets.

**Status — each has its own hue and a non-colour cue:**

| State | Token | Treatment |
|---|---|---|
| Live | `--live` (red) | `.live-marker`: static dot + the word "Live". Never pulses. Never on the container border. |
| Serving | `--serving` (white) | `.serve-marker`: a small white ball beside the server. |
| Winner | `--winner` | Bold weight. The loser steps down to `--loser` (chalk-300). No colour. |
| Rating up | `--rating-up` (green) | `▲ +12` — signed, with arrow. |
| Rating down | `--rating-down` (neutral) | `▼ −8` — losing points isn't an alarm. |
| Conflict | `--conflict` (amber) | Icon + a sentence explaining it + a suggested fix. Organizer screens. |
| Rest / timing | `--rest` (blue) | "Rest until 19:35". |
| Destructive | `--danger` | Text/outline on confirm actions only. |

## Type

- **Space Grotesk** (`--font-ui`) — every word in the UI: headings, labels, body, buttons, times in sentences.
- **JetBrains Mono** (`--font-num`) — scores and numbers that must align in columns (ratings tables, game scores, schedule times). Always `tabular-nums`.
- **Bebas Neue** (`--font-display`) — only the wordmark and surnames on big venue scoreboards. Not for app headings.
- **Labels are sentence case**, 13px, weight 500, no letter-spacing. No uppercase tracked overlines. Minimum size is 12px.
- Scale: 48 / 32 / 24 / 20 / 17 / 15 / 13 / 12, plus `--text-score` (96) for the scoring screen.

## Component roles (v2.1)

Each role has its own structure, so you can tell what it is before reading it.

| Role | Structure | Persistence |
|---|---|---|
| **Card** `.fm-card` | `--bg-panel`, no border. Title + status top-right, label/value details (`.fm-dl`), actions bottom-left, primary first. | Persistent information |
| **Inline notice** `.fm-notice` | Icon + sentence in the content flow. No surface. | Stays with its content |
| **Warning / error** `.fm-alert--warning/--error` | Tinted fill + full hue edge. Title = problem, body = why, buttons = fix. Errors `role="alert"`. | Until resolved |
| **Toast** `.fm-toast` | One compact line on `--bg-group` with `--shadow-overlay`, bottom centre. Check + message + Undo. Success only. | 6 s, pauses on hover/focus |
| **Tooltip** `.fm-tooltip` | `--bg-group`, `--fg-1`, `--border-control` edge, `--shadow-tooltip`, 13px, wraps at 280px. Hover + focus, Esc. | Supplementary only |

## Containers

- **Default is rows**, separated by whitespace or `--border-subtle`. Don't stack a doc separator, a component border and an internal rule.
- **Scroll areas** live inside their card with no frame of their own; sticky column heading, thin scrollbar.
- **Split views** separate panes by space; the resize handle is the only drawn element (drag or ← →).
- **Interactive edges are brighter than dividers:** `--border-field` (3:1) on inputs, unchecked checkboxes/radios, switch tracks, secondary buttons.
- **Shadows:** `--shadow-overlay` for menus, dialogs, toasts; `--shadow-tooltip` for tooltips. Nothing in the page flow has a shadow.
- Radii: 6 chips/inputs · 8 buttons/cards · 12 sheets/dialogs/score pads · pill for filter chips only.

## Demo behaviour

Gallery and app screens never pretend. Nothing is sent anywhere; actions change only the page, and **Undo is offered only when it really reverses that change** (`data-undo` with `data-done-label`, `data-hide` or `data-reveal`, or a page-level snapshot). Buttons that would need a server carry `data-demo` and say so when pressed. Static examples are labelled "Visual only".

## Selection controls

- **Tabs** — sibling sections of a page. **Segmented** — another view of the same data, one always on. **Filter chips** — narrow a list; several can be on; "All events" clears the rest and returns when none are on. **Switch** — a setting that applies immediately. Never use a switch to filter.

## States

Every interactive component documents default, hover, focus, pressed, selected, disabled, loading and error in `ui_kits/components/states.html`. Disabled ignores hover. Loading keeps the variant's colours and reads "Saving…". A focused invalid field keeps its red edge, icon and message.

## Spacing

4px scale (`--s-1` … `--s-16`). Pick for readability: 8–12 within a row, 16–24 between groups, 48–64 between page sections. No unit is a brand rule.

## Motion

| Use | Token | Behaviour |
|---|---|---|
| Button press | `--dur-press` 100ms | scale 0.98 |
| Hover, toggle, tab switch | `--dur-change` 160ms | background step |
| Score update | `--dur-score` 600ms | `.score-updated`: ink-700 flash on the changed number, once |

No infinite animations, no idle motion, no bouncing easing, no hover lift. `prefers-reduced-motion: reduce` collapses all animation and transitions (handled in `colors_and_type.css`).

## Components (see `preview/`)

Buttons · filter chips · inputs · avatars (flat initials, optional) · match row · schedule block · status markers. The full control set (forms, tables, tabs, menus, dialogs, alerts, toasts…) lives in `ui_kits/components/` with reusable `fm-*` classes in `kit.css`.

**Match row** (`.fm-match`) columns: name (wraps, never truncates) · serve marker · games won (boxed tally) · current points (large). Column labels once per list. States: live, upcoming, final, offline (greyed scores + last update), conflict. "Game scores" disclosure opens the history on tap — no hover needed.
**Score entry** (`.fm-scorepad`): 96px points, 64px "+1" targets, Undo last point, toast with Undo when a game is won.
**Game history** (`.fm-games`): game winner bold, current game highlighted.
**Schedule block** (`.fm-slot`): surnames stacked; full names in tooltip + accessible name. Scheduled = control border, live = `ink-800` + "Live", final = transparent, conflict = amber + "Needs decision", offline = dashed, free = dashed subtle, selected = orange edge.
**Rest** (`.fm-rest`, `.fm-meter--rest`): blue clock + end time. **Conflict**: amber alert with a suggested fix.
Shared renderers for all of these: `ui_kits/components/match.js` (`FMMatch`); behaviours: `ui_kits/components/kit.js` (`FM`).

## Organizer screens

Order of importance on the admin: expected finish vs plan → issues needing a decision (each with a fix button) → table status (live score, free + who's ready, rest blocking a call) → schedule timeline → scheduling details. Solver internals (variables, solve time, objective) live in a collapsed "Scheduling details" section.

---

## Voice

Plain, friendly, specific. Lead with what people can do.

| Context | Do | Don't |
|---|---|---|
| Hero | "Keep score, run tournaments and follow your club's results." | "Play more. Pay never." |
| Commitment | "We don't show ads." | "No ads. Not now, not ever. No horse shit." |
| Button | "Call to table" | "Let's go!" |
| Confirmation | "Match saved. Rating +12." | "Successfully saved match record" |
| Conflict | "Okafor's singles is 15 min over on Table 2. Move his doubles to 13:05?" | "Constraint violation: rest_min" |
| Empty state | "No matches yet. Log one after you play." | "Go play." |

- Second person for the user, "we" for FortyMM.
- State commitments (free, no ads, no tracking) once per page, as facts. Don't build sections out of what other apps do wrong.
- No decorative numbering (01, 02…), no manifesto headings, no emoji.
- Sentence case everywhere.

---

## Files

| Path | What |
|---|---|
| `colors_and_type.css` | All tokens, type roles, status markers, motion + reduced-motion |
| `preview/` | Design System tab cards |
| `ui_kits/components/` | Component library: `kit.css`, `kit.js`, `match.js`, gallery (`index.html`), state matrix (`states.html`) |
| `ui_kits/tournament/` | Organizer desktop + player/scorer mobile, built only from the shared components |
| `Components before and after.html` | v2 → v2.1 for tooltip, toast, card, field, buttons, match row |
| `ui_kits/ios/` | **Legacy v2 — do not copy.** Replaced by `ui_kits/tournament/mobile.html` |
| `ui_kits/android/` | **Legacy v2 — do not copy.** Replaced by `ui_kits/tournament/mobile.html` |
| `ui_kits/web_admin/` | **Legacy v2 — do not copy.** Replaced by `ui_kits/tournament/index.html` |
| `ui_kits/marketing/` | **Legacy v2 — do not copy.** Not rebuilt; compose from `ui_kits/components/` |
| `ui_kits/spectator/` | **Legacy v2 — do not copy.** Not rebuilt; compose from `ui_kits/components/` |
| `slides/` | Seven slide types on `deck-stage` |
| `Before and after.html` | v1 → v2 comparison and decisions |
| `assets/` | Flat logo mark + wordmark; `assets/before/` v1 screenshots |

Icons: Lucide, stroke 1.75, 20px (16px in dense tables). No emoji.

## Removed in v2 (don't reintroduce)

`--shadow-glow`, `--shadow-live-glow`, `.fortymm-grid-bg`, `ball-pulse`, `--ease-snap`, `.overline`, gradient avatars and logo, hero halos, the `--s-10` "40mm" spacing rule, the ● bullet motif, gold/silver/bronze rating chips, dashed orange schedule blocks, green winner text, coloured badge variants, shimmer skeletons, the crossed-paddles illustration, the ball-trail glow in the table illustration.

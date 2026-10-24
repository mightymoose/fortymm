---
name: fortymm-design
description: Use this skill to generate well-branded interfaces and assets for FortyMM, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read README.md, then `colors_and_type.css`. Build from `ui_kits/components/` (`kit.css`, `kit.js`, `match.js`; gallery in `index.html`, states in `states.html`). Copy screen patterns from `ui_kits/tournament/` and `slides/`. **`ui_kits/ios`, `android`, `web_admin`, `marketing` and `spectator` are legacy v2 — do not copy them.**

## Quick reference
- Dark, flat surfaces. No gradients, glows, textures, halos, idle animation.
- Orange `--accent` = actions and selection only.
- Live = red `.live-marker` (static). Serving = white `.serve-marker`. Winner = bold, loser = chalk-300. Rating up green ▲, down neutral ▼. Conflict amber with an explanation and a fix. Rest blue.
- One status signal per element.
- Space Grotesk for all words; JetBrains Mono for scores and aligned numbers; Bebas only for the wordmark and venue scoreboards.
- Sentence-case labels, 13px, no tracking. Minimum 12px.
- Roles: card = persistent info · inline notice = sentence, no box · alert = problem + fix, persists · toast = brief success + real Undo · tooltip = supplementary. Rows by default; overlays are the only shadows.
- Motion: 100ms press, 160ms change, 600ms one-shot score flash. Respect reduced motion.
- Voice: plain, lead with what people can do; state "free, no ads, no tracking" once.
- Organizer screens: expected finish, conflicts, rest, table availability first; solver details collapsed.

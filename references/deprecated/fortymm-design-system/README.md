# FortyMM Design System

> **The pinnacle table-tennis community, match tracker, and tournament platform.**
> Free forever. No ads. No tracking. Made by players, for players.

FortyMM is named for the 40mm diameter of a regulation table-tennis ball. The product covers:

- **iOS + Android apps** for players — match recording, ratings, club feed, opponent finder
- **Web tournament admin dashboard** — draws, scheduling, live scoring, reports
- **Public spectator bracket view** — shareable live draws for fans/family
- **Marketing website** — product landing, anti-SaaS manifesto

The tournament engine uses an **SMT solver** to generate optimally-packed schedules (court assignments, break constraints, back-to-back avoidance). This is core to the product's identity and shows up in copy and visuals as a "precision / math-under-the-hood" motif.

## Sources

This design system was built **greenfield** — no prior codebase, Figma, or brand assets were provided. Everything here is an original invention based on a single direction-setting conversation with the user. If existing assets or a Figma file exist in the future, they should be imported and reconciled against this system.

---

## Content Fundamentals

**Voice: a player talking to other players.** FortyMM is made by people who play. The copy should sound like a club notice board, not a corporate SaaS landing page.

### Tone rules
- **Direct, warm, a little cheeky.** "Log a match." "Call the winner." "Seed the draw." Short imperatives.
- **Second-person, always.** "Your ratings." "Your next match." Never "users" or "players" in-product.
- **First-person plural for the brand.** "We're free forever." "We don't sell your data."
- **Anti-SaaS, out loud.** Lean into what we *don't* do. "No ads. No premium tier. No cookie-consent dark patterns." This is a feature.
- **Numbers matter.** Scores, seeds, rating deltas are the poetry of this product. Show them proudly in mono, never round them away.
- **No emoji** in product UI. Emoji feels consumer-cheap and clashes with the broadcast aesthetic. The **orange ball dot (●)** is our emoji.
- **Sentence case** for UI labels, buttons, headers. Never title case. Never ALL CAPS (except for Bebas display and overline eyebrows).

### Example copy

| Context | ✅ Do | ❌ Don't |
|---|---|---|
| CTA | "Log a match" | "Record Your First Match Now!" |
| Empty state | "No matches yet. Go play." | "Get started by creating your first match" |
| Confirmation | "Match saved. Rating +12." | "Successfully saved match record" |
| Onboarding | "Pick your club. Or skip — we'll ask later." | "Welcome to FortyMM! Let's get you set up." |
| Manifesto line | "Play more. Pay never." | "Free, forever — no credit card required" |
| Error | "That player isn't in the draw." | "Error: invalid participant" |
| Broadcast | "● LIVE · Court 3 · Nguyen serves" | "Match in progress on Court 3" |

### Signature phrases
- **"Play more. Pay never."** — primary tagline
- **"For the love of the game."** — about-page opener
- **"Made by players."** — footer / about
- **"The math is quiet. The rallies are loud."** — SMT-solver pitch

---

## Visual Foundations

### Color vibe
- **Dark-mode-first.** The app is designed for phones at clubs in the evening, on broadcast monitors above the scorers' table, and on laptops in tournament-control rooms. A light theme is **out of scope for v1** — if we add one, it's a careful port, not the default.
- **Warm ink, not black.** Backgrounds are `#0B0D12` → `#171B24`, a near-black with blue-green undertone. Pure black would feel sterile and broadcast-cheap.
- **Orange is the ball.** `#FF7A1A` is our single hero. Use it for the primary CTA, live/important accents, the brand mark. Don't dilute — orange should always mean *something is the focus*.
- **Green means live / win.** `#00E29A` is the "serve" color — live matches, winning players, advancing in the bracket. Pairs with orange but is never the primary.

### Typography
- **Space Grotesk** — UI. Geometric, slightly warm, excellent at all sizes. Weights 400/500/600/700.
- **JetBrains Mono** — numbers. All scores, seeds, timestamps, ratings, court numbers. `font-variant-numeric: tabular-nums` always.
- **Bebas Neue** — display only. Used sparingly: big hero headlines, scoreboard moments, section intros. Never body copy.

Fonts are **self-hosted** in `fonts/`:
- `fonts/BebasNeue-Regular.ttf` — Bebas Neue (uploaded)
- `fonts/JetBrainsMono-VariableFont_wght.ttf` + italic — JetBrains Mono (uploaded)
- Space Grotesk still loads from Google Fonts CDN (not yet uploaded; swap in a local file when available)

`colors_and_type.css` declares the first two via `@font-face`. Preview HTMLs embed the font binaries as base64 data-URIs so they render correctly in sandboxed iframes., download the four families from fonts.google.com and drop them in `fonts/`.

### Backgrounds
- Pure flat dark ink by default. No gradients in the base UI.
- **Hero moments** use the **40mm dot grid** — a subtle radial-dot texture, 40px spacing (a brand nod), in translucent orange. Visible only on marketing surfaces and empty states.
- Occasional **warm halo gradient** behind the ball logo in hero units — orange radial glow fading to transparent. Never as a flat gradient background.
- No stock photography. Real tournament photos when available; otherwise the SVG table/paddle illustrations in `assets/`.

### Imagery
- Color vibe when photographs appear: **warm, desaturated, a touch of grain**. Think broadcast TV at a regional championship, not product-studio photography.
- **Monochrome treatment** (all-orange or all-ink duotone) is acceptable for hero photography.

### Animation
- **Easing: `cubic-bezier(0.2, 0.8, 0.2, 1)`** (var `--ease-out`) — default for every transition.
- **Ball-bounce easing** (`--ease-snap`) — reserved for score increments, bracket-advance, and win states. Feels like a ping-pong ball bouncing.
- Durations: **120ms** (micro-feedback), **200ms** (default), **360ms** (entering modals, celebrations).
- Live indicators **pulse** (`ball-pulse` keyframes, 1.4s).
- **No gratuitous motion.** This is a data-dense product; moving UI interferes with scorekeeping.

### Interaction states
- **Hover** (non-touch): lift via `--bg-hover` (`rgba(255,255,255,0.04)`), not a color change. For primary buttons: brighten orange `--ball-500` → `--ball-400`.
- **Press**: scale `0.97`, 120ms. No color change on press.
- **Focus**: 2px orange outline offset by 2px. Always visible. Keyboard users are respected.
- **Active / selected**: solid orange background with `--fg-inverse` text.
- **Disabled**: `--fg-disabled` text, `--bg-panel` background, no border change.

### Borders & cards
- **Border-default** is `--ink-500` (`#3A4152`), 1px hairline. Subtle — we don't want the UI to look gridded.
- **Cards** have `border-radius: var(--r-md)` (10px), **no** colored left-border accents (explicitly avoided — that pattern reads as 2018 SaaS). Cards distinguish by background shift (`--bg-card` vs `--bg-panel`), not borders.
- **Raised cards** get `--shadow-md`. Only floating elements (modals, menus) get `--shadow-lg`. Most cards get no shadow — elevation comes from background brightness.

### Shadows (elevation system)
- `--shadow-sm` — buttons, subtle lift
- `--shadow-md` — popovers, dropdown menus
- `--shadow-lg` — modals, sheets
- `--shadow-glow` — primary CTA on hover (orange glow)
- `--shadow-live-glow` — live-match cards (green glow)
- `--shadow-inset` — hairline highlight on pressed/active controls

### Transparency & blur
- **Sparingly.** Used on:
  - Status bars / nav bars over scrolling content (`backdrop-filter: blur(16px)` + `rgba(11,13,18,0.7)`)
  - Modal scrims (`rgba(11,13,18,0.75)`)
- Never on decorative elements. No frosted-glass cards.

### Radii
- `--r-xs` 4px — input focus rings, tight chips
- `--r-sm` 6px — form inputs, tags
- `--r-md` 10px — **default for cards, buttons, panels**
- `--r-lg` 14px — feature cards, hero CTA
- `--r-xl` 20px — modals, sheets
- `--r-pill` 999px — rating chips, filter pills, avatar containers

### Spacing
Strict 4px base grid. `--s-10` (40px) is used generously as a brand-nod multiple — section padding, hero gutter.

### Layout rules
- Bottom tab bar on mobile (5 tabs max). Top status bar sticky with blur.
- Admin dashboard: fixed left sidebar (220px), top action bar (56px).
- Marketing site: max content width 1180px, gutter 24px mobile / 64px desktop.
- **Scoreboard is always full-bleed.** When a match is live on this device, the score takes over the screen.

### The brand motif: the ball dot
An orange filled circle (●) appears throughout as:
- Bullet points in copy
- Loading indicator (pulsing)
- "Live" indicator (pulsing green variant)
- Unread / notification dot
- Serve indicator in match UI
- Period/end-of-line emphasis in the wordmark

---

## Iconography

**Primary icon set: Lucide** (lucide.dev) — loaded from CDN.

```html
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
```

**Rationale:** Lucide's stroke-based, slightly rounded-cap, sporty-clean aesthetic matches Space Grotesk and doesn't feel enterprise-y. Stroke width `1.75`, size `20px` default in UI, `16px` in dense tables.

**Substitution flag:** We did not ship a custom icon font. If FortyMM wants its own, the 8 most-used glyphs (trophy, bracket, court, paddle, clock, flag, plus, check) should be custom-drawn and the rest kept from Lucide.

**Brand-specific custom icons** live in `assets/`:
- `logo-wordmark.svg` — full lockup (ball + "FORTYMM")
- `logo-mark.svg` — ball only (favicon, app icon, avatar frame)
- `crossed-paddles.svg` — secondary mark / empty states / achievements
- `table-illustration.svg` — hero / section divider
- `empty-table.svg` — empty-state smaller variant

**Emoji: no.** The ball dot (●) replaces any "sparkle emoji" use.

**Unicode as icons: yes, sparingly.** `●` for the ball, `→` for navigation copy, `×` for close. Treat them as type, not icons.

---

## Index

| File / folder | What it is |
|---|---|
| `README.md` | This document |
| `colors_and_type.css` | All design tokens — color vars, type scale, spacing, radii, shadows, motion |
| `SKILL.md` | Agent-skill manifest for Claude Code / agent use |
| `assets/` | Logos, paddle/table SVG illustrations, brand marks |
| `preview/` | Design-system preview cards (rendered in the Design System tab) |
| `ui_kits/ios/` | iOS player app — components, click-through demo |
| `ui_kits/android/` | Android player app — components, click-through demo |
| `ui_kits/web_admin/` | Web tournament admin dashboard |
| `ui_kits/marketing/` | Public marketing site |
| `ui_kits/spectator/` | Public live bracket / spectator view |
| `slides/` | Sample slide templates (title, section, content, quote, comparison, scoreboard) |

---

## Using this system

**For designers / agents making FortyMM artifacts:**
1. Read `colors_and_type.css` first. Every color and type token lives there.
2. Pull real components from `ui_kits/<surface>/` — don't recreate from screenshots.
3. Match the voice in the content-fundamentals table above. If you catch yourself writing "Successfully" or "Welcome!", delete it.
4. When in doubt: dark background, one orange accent, mono numerals, no rounded-card-with-left-border, no emoji.

**Anti-patterns explicitly banned:**
- Bluish-purple gradient backgrounds
- Cards with colored left-border accent only
- Emoji in product UI
- "Premium" language, upsell CTAs, trial-ending modals
- Cookie banners (we don't track)

---
name: fortymm-design
description: Use this skill to generate well-branded interfaces and assets for FortyMM, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## Quick reference
- **Tagline:** "Play more. Pay never."
- **Hero color:** `#FF7A1A` (ball orange). Use it sparingly — one focus per screen.
- **Live color:** `#00E29A` (serve green). Live matches, winning states.
- **Background:** `#0B0D12` warm ink, NOT pure black.
- **Type:** Space Grotesk (UI), JetBrains Mono (all numbers), Bebas Neue (display only).
- **No emoji.** The orange ball dot (●) replaces emoji everywhere.
- **No gradients** (except the ball-sphere highlight). No rounded-cards-with-colored-left-border.
- **Anti-SaaS ethos:** free forever, no ads, no tracking, no premium tier. Say it out loud.

## Files
- `README.md` — full brand doc: content fundamentals, visual foundations, iconography
- `colors_and_type.css` — all design tokens
- `assets/` — logo, wordmark, paddle/table SVG illustrations
- `ui_kits/ios/` · `android/` · `web_admin/` · `marketing/` · `spectator/` — JSX components + HTML demos for each surface
- `slides/` — 7 sample slide types using `<deck-stage>`
- `preview/` — design-system cards

## Usage notes
- Fonts are loaded from Google Fonts CDN (not bundled). If you need offline, download from fonts.google.com.
- Icon set is Lucide from CDN: `https://unpkg.com/lucide@latest/dist/umd/lucide.min.js`
- When in doubt, copy a component from `ui_kits/` — do not reinvent.

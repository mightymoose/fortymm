# web-client UI design

The app follows the FortyMM design system (v2.1) in
`../references/design-system/`. Read these files before you design or style
UI:

- [README.md](../references/design-system/README.md): the principles,
  colour, type, component roles, containers, states, spacing, motion, voice
  and the v1 features that v2 removed.
- [SKILL.md](../references/design-system/SKILL.md): a one-screen quick
  reference to the README.
- [colors_and_type.css](../references/design-system/colors_and_type.css):
  the tokens and type roles. `src/styles/tokens.css` and
  `src/styles/base.css` copy them.
- [ui_kits/components/](../references/design-system/ui_kits/components/):
  the component library. `index.html` is the gallery that `/design-system`
  copies, and `states.html` shows every control in each state.
- [ui_kits/tournament/](../references/design-system/ui_kits/tournament/):
  organizer desktop and player mobile screens built from the components.
  Copy screen patterns from here.

Don't copy from `ui_kits/ios`, `android`, `web_admin`, `marketing` or
`spectator`. They are legacy v2.

Use the `fm-*` classes and the CSS variables. Don't use raw colours, raw
spacing or page-specific styles. The root `CLAUDE.md` (Styles) says which
files are copies that you must not edit.

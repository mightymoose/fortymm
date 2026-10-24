> **Legacy v2 — do not copy.** This kit predates the v2.1 component library (`ui_kits/components/`) and uses its own inline styles. Replaced by `ui_kits/tournament/index.html`.

# Web admin UI kit

Tournament director's "Tables & schedule" view.

- `components.jsx` — `AdSidebar`, `AdFacts` (expected finish, tables in use, matches left, resting), `AdAttention` (issues with a fix button — interactive), `AdTable` (live / free + ready / rest-blocked), `AdSchedule` (timeline, stacked surnames, now line, conflicts), `AdSolverDetails` (collapsed rules + solver internals).
- `index.html` — mounts `AdminApp`.

Priority order top to bottom: finish time → decisions → tables → schedule → technical details.

# Designer brief — Tournament surfaces for participants & directors

> **What I need from you:** high-fidelity mockups for the tournament experiences we're
> missing, for **two personas** (the player competing in a tournament, and the director
> running it), across **web** and **iOS** — including a **dashboard widget**, a set of
> **iOS screens**, and an **iOS Live Activity**. Everything below is grounded in the real
> product so the mocks are truthful, not aspirational fiction.

---

## 1. Product context

FortyMM is a table-tennis (ping-pong) platform. Players record 1-v-1 matches and carry a
rating; on top of that sits a **tournament engine** that already works end-to-end:

- A director creates a tournament, adds **events** (e.g. "Open Singles", "U1500 Doubles"),
  players **enter**, the director generates a **round-robin draw** (players split into
  **pools**), and a scheduler places every match on a physical **table** across the day's
  time windows. During play the director **calls** matches ("Table 6, you're up"), players
  report scores, and **pool standings** resolve to a **champion**.

The engine is built. The **UI is the gap**: today the tournament screens exist **only for the
director, and only for setup**. There is:

- **No participant experience** — a player who has entered a tournament has no "when do I play,
  what table, who's my next opponent, how am I doing in my pool" surface.
- **No tournament presence on the dashboard** (web or iOS).
- **Nothing tournament-related on iOS at all.**

### The two personas

| | **Participant** (player) | **Director** (organizer) |
|---|---|---|
| Wants | "When/where is my next match? Who do I play? Am I advancing?" | "What's happening across all my tables right now? What do I do next?" |
| Mindset | At the venue, phone in hand, between matches | Behind a laptop (or phone) running the room in real time |
| Primary device | **iOS** (they're on the floor) — web secondary | **Web** (control needs screen space) — iOS for glanceable ops |

Design for both. Most surfaces are the **same screen in two modes** (see the gating rule in §3).

---

## 2. Design system & output format

**Output:** self-contained, high-fidelity **HTML mockups** (one file per surface, or a single
scrolling page — your call), matching how this team already mocks screens. Precedents to open
first:

- `docs/match-details-amazing-mockup.html` (+ `.png`) — the fidelity bar and house visual style.
- **Web design system:** live at `/design-system` (`web-client/src/routes/design-system.tsx`).
  Tokens are **CSS custom properties**, not a Tailwind palette: text `--fg-1/2/3`, surfaces
  `--bg-card` / `--bg-raised`, `--border-subtle`; accents `--ball-500` (primary blue),
  `--serve-500` (green = live/go), `--warn`, `--loss`. Components are shadcn (`Card`, `Badge`,
  `Tabs`, `Table`, `Alert`, `Skeleton`, `Sheet`/`Drawer`) with **lucide** icons. It's a dark,
  scoreboard-forward aesthetic.
- **iOS design system:** `ios/Fortymm/DesignSystem/DesignSystemView.swift` and the `FM*` kit
  (`FMCard`, `FMBadge`, `FMButton`, `FMAlert`, `FMAvatar`, `FMTabs`, `FMTopBar`). Tokens in
  `Color+Tokens.swift` / `Typography.swift`. Match iOS platform conventions (large titles,
  Dynamic Island, SF Symbols) while staying visually of-a-piece with web.

Reuse existing card/stat patterns rather than inventing new ones where you can — call them out
so engineering can trace the lineage:

- Stat/rating card cluster: `web-client/src/components/dashboard/your-game-row/rating-card.tsx`
  (+ `sparkline`, `delta-pill`, `stat`). iOS equivalents: `DashboardRatingCard` /
  `DashboardRecentResultsCard`.
- Triage / action-row list: `web-client/src/components/dashboard/attention-panel.tsx`.
- Schedule/timeline boards: `web-client/src/components/tournaments/tournament-detail-page/schedule-tab/`
  (`gantt-board.tsx`, `player-timeline-board.tsx`, `tier-legend`).
- Standings: `tournament-detail-page/events-tab/standings/standings-panel.tsx` + `pool-standings-table.tsx`.

---

## 3. Hard constraints (please honor — these are real product rules, not preferences)

1. **Round-robin + pools only.** Single/double-elim, "RR-then-KO", and Swiss exist as labels but
   are **not implemented**. Do **not** design brackets. Standings = a **ranked pool table**
   (W-L, games/points, place). A KO bracket view is explicitly deferred.
2. **Read-only view, never a disabled form.** A participant looking at a director-owned surface
   sees a **clean read-only view** with the editing controls *removed* — not greyed-out or
   disabled buttons. The director sees the identical surface *with* controls. Design each
   two-mode surface as: (a) participant/read-only, (b) director/with-controls.
3. **Refusals are designed states, not dead buttons.** "Can't enter this event" has three real
   reasons: **registration closed**, **event full**, **rating-ineligible** (the player's rating
   is outside the event's band). Each gets an explanatory state, never a disabled "Enter".
4. **Lifecycle drives what's visible.** A tournament is `draft → published → live → archived`.
   Registration/entry is open **only** while `published`. Play (calling matches, live standings)
   happens while `live`. Design the participant + dashboard surfaces for both **published**
   (I'm registered, waiting for it to start) and **live** (it's happening now) states.
5. **A match's status is a first-class visual.** A fixture moves `pending → called → in-progress
   → complete`. "**Called**" is the money moment for a participant ("go to your table now") — it
   deserves the loudest treatment.

---

## 4. Surfaces to design

Priority order is marked. **P0 = the explicitly-requested minimum** (dashboard widget, iOS
screens, iOS Live Activity); do these first.

### WEB

#### 4.1 — Dashboard tournament widget  · **P0**
A card that appears on the existing dashboard (`/dashboard`) only when the user is involved in an
active tournament. **Role-adaptive:**

- **Participant mode:** the tournament I'm in, my **next match** front-and-center — opponent
  (avatar + name), **table**, scheduled time or a loud "**You're up — Table 6**" when called,
  my current **pool standing** (e.g. "2nd of 6"), and a button into the tournament.
- **Director mode:** my **live** tournament at a glance — counts of matches *in progress* /
  *awaiting a table* / *completed*, the single most useful next action, and a link to the
  control tower (§4.3).
- **States:** none (widget absent), published-but-not-started ("Starts at 9:00 · 12 players"),
  live, and the "called" alert variant. Show loading (skeleton) and the multi-tournament case
  (I'm in two at once).

#### 4.2 — Participant tournament experience  · **P1**
The missing player view. Can be a new **"My schedule"** tab on the tournament detail page (which
today has Events / Tables / Schedule / Details, all director-oriented). Content:

- **My next match** hero — opponent, table, time / called state, "report score" hand-off.
- **My day** — a per-player timeline of my matches (done / now / upcoming) with tables and times.
- **My pool standings** — the ranked table for *my* pool, me highlighted.
- **Roster / who's here** — entrants, my seed/rating.
- **States:** registered-waiting (published), live, eliminated/finished, champion.

#### 4.3 — Director live "control tower"  · **P2**
A focused real-time ops view distilled from the existing (setup-heavy) Schedule tab — for running
the room, not configuring it. Content: what's **callable now**, **table occupancy** (which table
has whom, for how long), **who's waiting**, one-tap **call**, and the lifecycle control
(start/end). Lean on `gantt-board.tsx` / `solve-strip.tsx` as precedent.

#### 4.4 — Public spectator view  · **Stretch**
Read-only standings + schedule for a shared/public link (only a marketing mock exists today).
Nice-to-have; skip if time is tight.

### iOS

#### 4.5 — Tournaments tab / entry  · **P0**
There's no tournament anywhere on iOS today. Tabs are Dashboard / Matches / Profile
(`MainTabView`). Add a **Tournaments** entry: a list of tournaments I'm **in** or **directing**,
each row showing status + my next-match hint. Mirror `MatchesListView` structure and the `FM*`
kit.

#### 4.6 — iOS tournament detail (participant)  · **P0**
The phone-in-hand-at-the-venue view: **my next match** (opponent, table, called state), **my
schedule** for the day, **my pool standings**. Score entry reuses the existing
`MatchFlowView` / `ScoreEntryView` — design the hand-off, not a new score pad.

#### 4.7 — iOS tournament detail (director, lightweight)  · **P1**
Glanceable ops for a director on their phone: live counts, **"call next match"**, lifecycle at a
glance. Heavy editing stays on web — this is monitoring + the one or two actions you'd do while
walking the floor.

#### 4.8 — Push: "your match is called"  · **P1**
A notification design for "**Table 6 — you're up**". Extends the existing push pattern (deep-links
by category + id, `PushNotificationManager.swift`). Show the banner, and — where it makes sense —
a quick action. This is the trigger that launches/updates the Live Activity below.

#### 4.9 — iOS Live Activity  · **P0 · the marquee**
Lock screen + **Dynamic Island**, live-updating as my fixture moves through its states. This is
the flagship — spec all the required presentations:

- **Participant content by state:**
  - *On deck / called:* "**You're up — Table 6**", opponent name, a "head to your table" nudge.
  - *In progress:* live **game score** (e.g. 2–1 games, 8–6 current game) if we surface it,
    else "Now playing · Table 6 · vs Priya".
  - *Complete:* result + "next match at 2:40" if there is one, then it ends.
- **Required presentations** (design each):
  - **Lock-screen / banner** (the full layout).
  - **Dynamic Island — compact** (leading + trailing, e.g. a table icon + "T6").
  - **Dynamic Island — expanded** (opponent, table, score/CTA).
  - **Dynamic Island — minimal** (single glyph when multiple activities compete).
- Keep it legible at a glance and on-brand with the `FM*` palette.
- *(Engineering footnote, not a design ask: this is greenfield — there is no Live Activity /
  WidgetKit target in the app today, so it needs a new Widget Extension target. Design freely;
  I'm flagging it only so estimates account for the new target.)*

---

## 5. The data each surface may show (so nothing is invented)

Drawn from the real types (`web-client/src/components/tournaments/data/types.ts`,
`api/app/models/tournament.py`). Use these fields; don't, e.g., show a bracket
seed line that doesn't exist.

- **Tournament:** name, `status` (draft/published/live/archived), dates, address/venue, table
  count, events, pool count.
- **Event:** name, `format` (singles/doubles/teams), `drawType` (**round-robin** in practice),
  entry fee, max players, my entry state, eligibility band (rating min/max), pools, fixtures,
  standings, champion (when complete).
- **Fixture (a scheduled match):** the two entries (or "TBD"), winner, `matchStatus`
  (pending/called/in-progress/complete), `tableId`, `scheduledStart`, `pinnedAt`,
  times-called count, `completedAt`. (A **bye** = a fixture side that's simply absent — never a
  literal "bye" chip.)
- **Standing row:** rank/place, entrant, W-L, games/points for/against. Server-ranked — present
  in the given order, don't re-sort.
- **Entrant:** name, avatar, seed, rating (may be **unrated / null** — design for that).
- **Table:** label + court/area.

---

## 6. Deliverables checklist

- [ ] **P0** Web dashboard tournament widget — participant + director modes, all states.
- [ ] **P0** iOS Tournaments tab/entry.
- [ ] **P0** iOS tournament detail (participant).
- [ ] **P0** iOS Live Activity — lock screen + all three Dynamic Island presentations, by state.
- [ ] **P1** Web participant tournament experience (my-schedule tab).
- [ ] **P1** iOS tournament detail (director, lightweight).
- [ ] **P1** iOS "your match is called" push.
- [ ] **P2** Web director live control tower.
- [ ] **Stretch** Public spectator view.

For every surface, include its **empty / loading / refusal / live** states, and note which
existing component (§2) it echoes so engineering can trace it.

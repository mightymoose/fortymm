# The match store and background sync: design plan

Status: planning only, nothing implemented. Written 2026-11-14 for the web client.
It follows `DESIGN-primitives.md` (called "the design" below) and, where the design is silent, `PLAN-offline-scoring.md`. Section 12 lists where it departs from either, and why.
Decisions marked **[open]** are listed again in section 11 with a recommendation.

## 1. Summary

Two pieces, built in this order.

1. **The match store.** An in-memory zustand store, keyed by match id, in front of IndexedDB. A page reads it and calls its actions. It never holds anything that isn't on disk: every value in it was read from IndexedDB, after the write that produced it finished. No `persist`.
2. **Sync.** One cycle that sends this device's unsent records and then pulls new ones. Pulled records are verified by the core, written through `storage.ts`, and announced. The cycle never touches the store.

One rule joins them: **every write to `fortymm-storage` is announced, and every announcement makes each tab reload from IndexedDB what its mounted pages are reading.** A local tap, a pull, another tab and (later) a live stream all reach the screen by that one path.

```
tap ─▶ store action ─▶ journal.commit ─▶ storage (one transaction) ─▶ announce ─┐
pull / stream ─▶ core verifies ─▶ storage (one transaction) ─▶ announce ────────┤
                                                                                ▼
                         every tab: store reloads watched matches from IndexedDB ─▶ screen
```

What exists today: `storage.ts` keeps hellos only; the core's browser build makes one kind of record (hello) and has no rules; the api serves `GET /v1/health` and nothing about records. (`origin/apply-match-records` has a temporary match endpoint and an older core wrapper. It is not on `main` and this plan does not build on it.)

Scope: `match` and `score` records, the temporary scores of design section 4. Signing a result (`result` records, the QR handover) uses the same store, storage and sync paths; its screens are a later plan.

## 2. Modules and who owns what

| Module | Owns | Never does |
|---|---|---|
| `src/storage.ts` (widened) | The `fortymm-storage` database: record bytes, the journal's order and states, the rows minted from records, the pull cursor. Calls the core to read records and derive match state. Announces each write it commits. | Network, the key, React |
| `src/journal.ts` (new) | `commit`: the only way the app makes a record. Builds the body with the core, signs with the device key, stores through the held store, all inside one `withDeviceKey` callback. | Decide what a tap means; touch the store |
| `src/matches/changes.ts` (new) | Telling this tab and the others what changed: one `BroadcastChannel`, one message type. | Read or write data |
| `src/matches/store.ts` (new) | The zustand store, its one queue, the actions pages call, and the rule for which matches to reload on a change. | IndexedDB, core or key calls of its own; network |
| `src/sync.ts` (new, after the first epic) | The sync cycle and when it runs. | Write to the store; write to IndexedDB except through `storage.ts` |
| `src/api/parcels.ts`, `src/api/records.ts` (new, with sync) | The two api calls, parsed with zod like `src/api/health.ts`. | |
| `src/live.ts` (new, last) | The server-sent events connection (section 8). It only asks `sync.ts` to run a cycle. | Carry records; write anything |

Routes stay thin: a path, a loader that calls one store function, one component.

### `src/matches/changes.ts`

```ts
type Change = {
  revision: number          // storage's change counter after the write
  matches: string[] | 'all' // match ids (hex) the write touched; 'all' past 20, and for an upgrade
  account: boolean          // this device's user or its name changed
}
function announce(change: Change): void                      // this tab's listeners, then the channel
function onChange(listener: (change: Change) => void): () => void
```

- A `BroadcastChannel` named `fortymm-changes`. The browser doesn't deliver a message to the tab that posted it, so `announce` calls this tab's listeners itself first.
- Only `storage.ts` calls `announce`, after a write transaction completes. No writer can forget.
- A message can be missed (a frozen tab, a page restored from the back/forward cache). So the store also treats "the page became visible" and `pageshow` as a `{ matches: 'all' }` change. A missed message costs one reload on return, never a wrong screen.

### `src/storage.ts`

Database version 2. Version 1's stores stay as they are.

| Store | Key | Holds |
|---|---|---|
| `records` (as now) | record id | the signed bytes |
| `journal` (new) | `seq`, auto-increment | `{ id, match: hex or null, kind, state: 'held' or 'acknowledged' or 'stuck', own: boolean }`; indexes on `id` (unique), `match`, `state`. The counter of design 5.4 and the states of design 5 |
| `matches` (new) | match id | `MatchSummary`, a copy for the list, rewritten in the same transaction as every record of that match |
| `sync` (new) | fixed names | `revision` (a counter every write transaction raises by one) and `cursor` (section 6) |
| `users`, `me` (as now) | | |

The upgrade from 1 adds the stores and gives each record already kept (hellos) a `journal` row, held. It runs in the upgrade transaction, so it happens whole or not at all.

```ts
// Reads: no lock, one transaction each.
loadMatch(matchId): Promise<{ ok: true; match: MatchState | null; revision: number } | Unavailable>
loadMatches():      Promise<{ ok: true; matches: MatchSummary[]; revision: number } | Unavailable>
// Added to the held Store (inside withDeviceKey only):
store.loadMatch(matchId)                 // same answer, for a commit to read what is current
store.append(record)                     // a record this device made: held, own
// For sync (takes the append lock itself):
heldRecords(limit): Promise<...>         // journal order, scores after everything else (J7)
markAnswered(answers): Promise<...>      // held -> acknowledged or stuck, by record id
storePulled(records, cursor): Promise<{ ok: true; kept: number; rejected: number } | ...>
loadCursor(): Promise<...>

type Unavailable = { ok: false; reason: 'storage-unavailable' | 'core-unavailable' }
```

- `MatchState` is what a page shows, derived by the core from the match's records (section 9, core task C): the sides with their usernames, the terms, each game's shown score, whether a game is contested (section 5), the ids of the current entries per game, and `unsent`, how many of this match's records are still held. Ids are hex; no bytes leave `storage.ts`.
- `loadMatch` reads the match's records by the `match` index and derives. Nothing derived is cached but the list's summary. A match scored point by point is a few hundred records of about 200 bytes; the derivation is synchronous in the core and takes well under a frame. That is why no worker is needed: the page version would not stutter. If a measured read ever passes 16 ms, cache `MatchState` in the `matches` row, written in the same transaction.
- A record whose match record isn't kept yet is still stored (design L2); `loadMatch` gives `null` until the match record arrives.
- Failures stay typed results, never thrown.

### `src/journal.ts`

```ts
type Draft = (ctx: {
  core: Core; signer: Uint8Array; random: Uint8Array; store: Store
}) => Promise<Uint8Array | { refused: string }>   // a body, or why not

function commit(draft: Draft): Promise<
  | { ok: true; id: string; match: string | null }
  | { ok: false; reason: DeviceKeyFailure | StoreFailure | 'refused'; why?: string }
>
```

Inside one `withDeviceKey` callback: draw 8 random bytes, run the draft, sign the body, `core.assemble` (which verifies, design 4.5), `store.append`. The draft reads through `store`, inside the lock, so what it decides on is what is on disk at that moment, whatever any tab's memory says. The first launch can move onto `commit` later; it need not.

### `src/matches/store.ts`

```ts
type MatchEntry =
  | { status: 'ready'; match: MatchState; revision: number; saving: number; failure: Failure | null }
  | { status: 'missing' }                       // no match record on this device
  | { status: 'unavailable'; reason: 'storage-unavailable' | 'core-unavailable' }

type State = {
  matches: Record<string, MatchEntry>
  list: { status: 'ready'; matches: MatchSummary[]; revision: number } | { status: 'unavailable'; ... } | null
  sync: SyncStatus                              // section 6; 'off' until sync exists
}

// For loaders: resolve once the entry (or the list) is in the store.
loadMatch(matchId): Promise<MatchEntry>
loadList(): Promise<void>
// For pages: mark a match (or the list) as on screen. Returns the function that stops.
watchMatch(matchId): () => void
watchList(): () => void
// Hooks for the connected components (section 4).
useMatch(matchId): MatchEntry | undefined
useMatchList(): State['list']
// Actions. Each resolves when the screen's state is up to date.
createMatch(sides, terms): Promise<ActionResult & { matchId?: string }>
scorePoint(matchId, game, side, from: [number, number]): Promise<ActionResult>
setGameScore(matchId, game, value: [number, number], from): Promise<ActionResult>   // typed entry, undo

type Failure = { reason: 'storage-unavailable' | 'locks-unavailable' | 'signing-unavailable' | 'core-unavailable' | 'changed' }
type ActionResult = { ok: true } | ({ ok: false } & Failure)
```

- **One queue.** Every job that sets store state runs on one promise chain in this module, one at a time: a local action (commit, then reload) and a reload caused by a change. A reload that began before a write can therefore never land after it and wipe a point off the screen.
- **A reload is the only thing that sets a match.** It calls `storage.loadMatch` and replaces the entry. A local action ends with the same reload. So there is one code path from disk to screen, and nothing to roll back.
- **Revisions drop stale work.** A change whose `revision` is not above the entry's is ignored. This is also what makes the tab's own announcement, arriving after its action already reloaded, cost nothing.
- **Only watched matches reload.** On a change, a named match that a mounted page is watching is reloaded. A named match nobody is watching has its entry deleted; the next page that opens it reads it fresh through its loader. An unnamed match is left alone. The list reloads if it is watched, and is set to `null` otherwise.
- The store is created with zustand's vanilla `createStore`, exported with its hooks, so a test can build a fresh one.

## 3. A local action, step by step

`scorePoint(matchId, game, side, from)`, where `from` is the game's score on the screen when the person tapped.

1. The action joins the queue. The entry's `saving` goes up by one (the control shows it is working; the score does not change).
2. `journal.commit` takes the append lock and the device key.
3. Inside the lock, the draft reads the match with `store.loadMatch`. If the game's shown score is not `from`, it refuses with `changed`: the score moved under the person, and adding to a score they never saw could count one point twice.
4. Otherwise it builds a `score` record for that game with the new absolute value (never an increment, `PLAN-offline-scoring.md` section 5), naming as replaced every entry current for the game. Sign, assemble, `store.append`: the record, its journal row, the summary and the revision in one strict transaction.
5. The lock is released. `storage.ts` announces `{ revision, matches: [matchId] }`.
6. Still inside the queue job, the store reloads the match from IndexedDB and replaces the entry. `saving` goes down. The promise resolves.
7. Other tabs get the message and reload the match if a page of theirs is watching it. `sync.ts`, when it exists, is asked for a cycle.

No optimistic update. A tap costs a signature, one strict write and one read: tens of milliseconds. If tap-to-paint measures above 100 ms on a mid-range phone in the browser suite, revisit; until then the simple rule holds.

| Failure | What is kept | What the screen shows |
|---|---|---|
| `storage-unavailable`, `locks-unavailable` | Nothing | The score unchanged, and an alert on the page: "That point wasn't saved. This browser isn't letting FortyMM store data." It stays until the next action succeeds |
| `core-unavailable` (the module didn't load) | Nothing | The score unchanged: "That point wasn't saved. Reload and try again." A load that fails is forgotten, so the next tap tries again |
| `signing-unavailable` | Nothing | As storage, naming signing |
| `changed` | Nothing | The new score, already on screen after the reload, and a notice: "The score changed on another device. Check it, then tap again." |
| The tab is closed mid-write | The whole record or none (J3) | On reopening, what is on disk |
| No network | The record, held | The score; "Saved on this device" (section 7) |

`createMatch` is the same flow with a `match` draft. It names this device's own player (`loadMe`) on one side. How the other side is named is not settled here (section 11, question 2).

## 4. Pages: what each subscribes to, and what a change does

"What should happen" is the page's decision. The store only guarantees that what a mounted page watches is current.

| Page | Watches | When a record for its data lands (local, pull or another tab) | For anything else |
|---|---|---|---|
| Match details, `/matches/$matchId` | That match | The entry is replaced; the page shows the new score in place | Nothing |
| Scoring, `/matches/$matchId/score` | That match | The same. If the person's next tap carries an old `from`, the `changed` rule of section 3 applies | Nothing |
| Match list, `/matches` | The list | The summaries are read again (one small read); rows are keyed by match id, so one row changes or one is added and the rest don't re-render | Nothing |
| Settings | Nothing in the store. It keeps its loader (`ownAccount`) | Nothing for a match. For `account: true` (a name confirmed, once sync brings identity state): the root calls `router.invalidate()`, which reruns the loader and keeps the old screen until the answer | Nothing |
| Every other page | Nothing | Nothing. Named entries nobody watches are dropped | Nothing |

**Loaders and subscriptions.** The loader makes sure the data is in the store; the page subscribes for what comes after.

- The route's loader calls `loadMatch(params.matchId)` and awaits it, so the router's pending component covers the first read, and a `missing` entry becomes `notFound()`. It returns nothing: the match is never copied into loader data, where it would go stale.
- The page then reads with `useMatch(matchId)` and calls `watchMatch(matchId)` in an effect while mounted.
- Match data is never refreshed with `router.invalidate()`. Invalidation reruns loaders and can show pending states; a subscription replaces the data under a mounted page with neither. Invalidation is kept for loader-only pages (settings).

**Where the subscription lives [open, question 6].** `web-client/CLAUDE.md` says a screen takes everything as props and a route file holds no hooks of its own. So each page gets one small connected component in `src/components/`: `MatchDetails.tsx` reads the store (`useMatch`, `watchMatch`), and renders `MatchDetailsScreen` with plain props (`match`, `saving`, `failure`, `onScorePoint`). The route wrapper hands it `matchId`. The screen stays a pure function of its props, tested as screens are today; the connected component is tested once against a real store.

**What the person sees while data is replaced.**

- No flash. An entry stays `ready` with the old data while a reload reads; it is swapped in one `set`. Nothing shows a loading state after the first load.
- Scroll and focus stay. The same components stay mounted; lists are keyed by match id and games by game number, so React changes text, not elements.
- A score that changes mid-entry. On the tap screen, the `changed` rule. In a typed form (a game entered as 11-7), the draft lives in the form's own state, which a store update doesn't touch; the form shows "This game was changed to 9-7 on another device" beside the field, and submitting sends the `from` it started with, so the same rule decides.

## 5. Conflicts

The design settles most of this. One gap is named.

| Case | Rule | Source |
|---|---|---|
| A duplicate (the same record pulled twice, pulled after being made here, or delivered by two tabs) | A record is keyed by its id and kept once. The second write changes nothing. A record of this device coming back in a pull moves from held to acknowledged | Design 4.2, L3; `storage.ts` today |
| One body with two signatures | One id, the same record; the first kept stays | `storage.ts` today |
| Out of order (a score before its match, a newer score before the one it replaces) | Records are a set. The state is derived from the set, never from arrival order. A score is stored before its match is known and shows once the match arrives | Design L2, L4 |
| A stale score arriving late | An entry replaces only the entries it names, so it cannot displace a newer one | Design 7.2, last row |
| Two devices scoring the same game without seeing each other | Both entries are *current* (neither names the other). "Which to show is a policy function of the set" | Design section 7, Scoreboard; section 16 |
| Two tabs of one device | Cannot fork: each commit reads what is current inside the append lock | Section 3, step 3 |
| A record the core rejects | Not stored (below) | Design R1 |

**The gap: the function that picks which of several current entries to show.** The design leaves it as a parameter. The smallest rule **[open, question 3]**: show the entry with the most points in total; if equal, the one with the higher record id. It needs no clock and gives every device the same answer for the same set. `MatchState` marks the game `contested`, and the page says "Also being scored on another device". The next point scored by either device names every current entry as replaced, so the fork closes by itself. The rule lives in the core, so the server shows the same score.

Results and their conflicts (two signed results, corrections, the seen list) are settled by design section 7 and are outside this plan.

## 6. Sync: one cycle, send then pull

**Pushing is part of the same job.** The design's sync loop is one cycle: send held records as a parcel, mark what the server acknowledges, then pull (design section 5). Sending first means the pull that follows already includes the device's own records as the server ordered them.

```ts
type SyncStatus =
  | { state: 'off' }                        // no sync in this build, or no account yet
  | { state: 'idle'; unsent: number }
  | { state: 'running'; unsent: number }
  | { state: 'waiting'; unsent: number; why: 'offline' | 'server' | 'storage' | 'core' }

function startSync(): { now(): void; stop(): void }   // main.tsx, after the first paint
```

**One cycle.** Inside the Web Lock `fortymm-journal-sync`, requested with `ifAvailable`: if another tab is in a cycle, this one does nothing (J2).

1. `heldRecords(100)`. If any: build a parcel with the core, `POST /api/v1/parcels`. The answer names each record: held, applied, refused, retry later or malformed. `markAnswered` moves held and refused to acknowledged (the server holds them) and malformed to stuck, in one transaction, and announces the matches touched, so "saved" changes on screen. Retry-later records stay held.
2. `loadCursor()`, then `GET /api/v1/records?player=<own player id>&after=<cursor>`.
3. The answer is a parcel, a new cursor and `more`. `core.parse`; a damaged parcel stops the cycle with nothing stored. Each record is verified (`core.verify`); one that fails is counted and skipped.
4. `storePulled(records, cursor)`: the records (acknowledged at once), their journal rows, the summaries, the revision **and the new cursor** in one transaction inside the append lock. Then `storage.ts` announces the matches touched.
5. While `more` is true or records are still held, go again, at most 10 rounds; then release the lock.

Each request has a timeout, so a cycle holds the lock for a bounded time.

**The cursor.** Opaque text from the server: the arrival number of the last record sent (design 7, "arrival number"; design 5, "the pull asks only for records that arrived after the last one the device has seen"). It is kept in the `sync` store and written in the same transaction as the records it covers, so it can never run ahead of what is on disk. Not in `localStorage`: that could not be written with the records. If storage is wiped, the cursor goes with it and the next pull starts from the beginning.

**The gap: a record that becomes this device's business after the cursor passed it.** A score can reach the server before its match record (design L2). A feed of "records of my matches, after arrival number N" would skip it for ever once N has passed it. Smallest rule: the server gives a record its place in a player's feed when it first becomes attributable to one of that player's matches, not when it arrived; in practice, when a match record is stored, the records already held for that match are placed in the feed after it. The cursor stays one number.

**What the first pull does not carry.** The design's pulled view also has outcome states, each match's tags, identity state and the stamp. None is needed for matches and scores. They join the same answer later; the client flow doesn't change.

**When a cycle runs** (in the page, like `new-version.ts`): at startup once the first launch has settled; two seconds after a local commit (so a rally of taps is one parcel); when the page becomes visible; when the connection returns; every 15 seconds while a match is watched and the page is visible, every 5 minutes otherwise **[open, question 5]**. After a failure it waits 5 seconds, doubling to 5 minutes, with jitter; a success or `online` resets it. Background Sync in the service worker is not built: it is Chromium only, and the design calls it a bonus.

| Failure | What happens | What the screen shows |
|---|---|---|
| No network, a timeout, 5xx, 429 | Nothing is written. Held records stay held, the cursor stays. Backoff | Scores as they are, "Saved on this device". No error: nothing is wrong |
| `storage-unavailable` on any step | The cycle stops. Nothing half-written: each step is one transaction | Whatever the page's own reads and actions already show for storage |
| `locks-unavailable` | No cycle ever runs: without locks there is no single writer | As above. Such a browser has no account either |
| `core-unavailable` | No cycle; the next trigger loads the core again | Nothing extra |
| The pulled parcel is damaged | Nothing stored, cursor unchanged, backoff, retried | Nothing |
| One pulled record doesn't verify | Skipped; the rest of the page is stored and the cursor moves past it, or the device would ask for it for ever. Counted in `storePulled`'s `rejected` | Nothing. This is a server defect, logged to the console |
| The server calls one of our records malformed | It becomes stuck: kept, never sent again | "1 score couldn't be sent" on the match, since the design says this is a defect and should be unreachable |
| The tab closes mid-cycle | The lock is released by the browser. Sent records not yet marked are sent again; the server answers as it did the first time (L3) | Nothing |

## 7. What "saved" means, and startup

**Saved.** Because the store only shows what was read from disk, everything on screen is saved on this device. The screen never has an unsaved score to mark. What varies is whether the server holds it:

| State | When | Shown on the match |
|---|---|---|
| Saving | `saving > 0` | The tapped control is busy |
| Saved on this device | `match.unsent > 0`, or sync is off | "Saved on this device" |
| Synced | `match.unsent === 0` after a cycle | "Synced" |
| Needs attention | A stuck record | Section 6's last-but-one row |

Before sync exists every match says "Saved on this device".

**Startup.** Nothing is loaded eagerly and nothing is rebuilt: the store starts empty, and the first page's loader reads what that page shows. `main.tsx` renders, starts the first launch as today, and calls `startSync()`, which waits for the launch to settle.

**Reopening mid-match with no connection.** The service worker serves the app and the core's module. The loader's `loadMatch` reads the match's records and derives the state: the score is exactly what was on screen when the tab closed, since nothing was ever shown before it was on disk. Scoring goes on; each point is held. The first sync cycle fails quietly and waits for `online`. Nothing on the page says anything is wrong.

## 8. Server-sent events

A stream from the api can tell an open page that new records exist, so it need not wait for the timer.

**Recommendation: build the pull first, and add the stream later as a trigger only.**

| | Trigger only (recommended) | Stream carries the records |
|---|---|---|
| What an event says | "Something for you changed", with the new cursor as its `id` | The records themselves |
| What the client does | Asks `sync.ts` for a cycle, which pulls from the stored cursor | A second intake path: parse, verify, store, move the cursor |
| Paths that write to storage | One (the pull) | Two, which must agree on ordering and the cursor |
| A lost or repeated event | Harmless | Must be handled |

A trigger keeps the rule of section 1 untouched: the stream writes nothing, anywhere. Records still arrive by the pull, are verified by the core, written by `storage.ts` and announced; the stores reload from IndexedDB.

- **Catch-up.** The stored cursor is the only truth. `Last-Event-ID` is not used for it. Streams drop (a background tab in Safari, sleep, a network change, the hosting's time limit), so on every open and every reconnect the client runs one ordinary cycle. An event's payload is only ever a hint to pull.
- **Which tab holds the connection.** One per device. A tab that is visible and watching a match requests the Web Lock `fortymm-live` and keeps the stream open while it holds it; it lets go when hidden or when no match is watched. The next tab waiting gets the lock, which is the handoff, with no election to write. The other tabs learn of new records as they always do: the leader's pull writes, and `storage.ts` announces on the `BroadcastChannel`.
- **Offline.** The stream is an accelerator and never the only path. With no connection it fails to open and retries with the same backoff as the cycle; scoring, reading and the timer pull behave exactly as without it. Every claim in sections 3 to 7 holds with `live.ts` deleted.
- **The api side.** `GET /v1/records/stream?player=<id>`, `text/event-stream`: an event when a record enters that player's feed, and a comment line every 25 seconds so idle links stay open. With more than one instance, each needs to hear of records stored by the others; PostgreSQL's `LISTEN`/`NOTIFY` does that with the driver already in use (asyncpg), one listening connection per instance.
- **Through the Worker.** `toApi` in `web-client/worker/src/index.ts` hands back the api's body as a stream (`new Response(response.body, response)`) and sets `Cache-Control: no-store`, so nothing in the repo buffers it. The service worker never answers `/api/`.
- **Not confirmed; check before building.**
  - That a long-lived streamed response passes the Worker's `fetch` to Cloud Run unbuffered, and for how long. Nothing in the repo exercises it. It is hosting, so its proof is one test in the cross-app suite (section 10).
  - Cloud Run's request time limit. `api/hosting/preview.sh` sets none, so the default applies (I believe 5 minutes, raisable to 60); the stream is cut then and must reconnect, which the catch-up rule already covers.
  - Cloudflare's idle limit on a response with no bytes (I believe about 100 seconds), which the 25-second comment is there to beat.
  - Vite's dev proxy passing the stream.
- **Cost.**
  - Cloud Run bills an instance for as long as it has a request open. One open stream keeps one instance up and billed, where today's previews scale to zero (`--min-instances=0`). Holding the stream only while a match is on screen in a visible tab bounds this.
  - Each stream takes one of an instance's concurrent request slots (80 by default; previews are capped at one instance).
  - Each stream is one Worker request, and each reconnect another; that counts against the Workers plan's daily requests. I could not confirm the current plan limits from the repo.
  - Polling every 15 seconds while a match is watched costs 4 requests a minute per watching device and lets the api scale to zero between them. For a few devices it is the cheaper choice.

So: polling first. Add the stream when 15 seconds is too slow for people watching a match, as tasks N and O of section 9. It changes no earlier task; when it lands, the timer while watching can relax to a minute.

## 9. What has to be built, in order

Each line is one worker and one pull request. "After" names what must be merged first.

**The first epic: everything on the device.**

| # | App | Task | After |
|---|---|---|---|
| A | core | The two product layouts the core carries as opaque bytes today: match terms and the score value, each with a version (`FORMAT.md`, `layout.rs`), with a function to write and one to read each. Needs question 2 answered | none |
| B | core | In the browser and Python builds: `matchBody` and `scoreBody` (the `Draft` constructors exist in Rust), `kind`, the match a record is about, and a score's game, value and replaced ids. Vectors | none; independent of A |
| C | core | The rules: `matchState(records)`: which entries are current, the shown score per game (question 3), contested, the current ids. A pure function of the set, with golden vectors | A, B |
| D | web-client | `storage.ts` version 2: the stores of section 2, the upgrade, `store.append`, `loadMatch`, `loadMatches`, the revision. It accepts `match` and `score` records | B, C |
| E | web-client | `src/matches/changes.ts`, and `storage.ts` announcing | none; independent (the call from `storage.ts` lands with D or E, whichever is second) |
| F | web-client | `src/journal.ts`: `commit` | D |
| G | web-client | `src/matches/store.ts`: the store, the queue, the actions. Adds the `zustand` dependency | D's types, E, F. Can start against `storage.ts` and `journal.ts` replaced at their interfaces once D is merged |
| H1 | web-client | Create a match, and the match list page | G; question 2 |
| H2 | web-client | The match details page, and the two-tab browser test | G |
| H3 | web-client | The scoring page, with the `changed` rule | G |

H1, H2 and H3 are independent of each other.

**After it: sync.**

| # | App | Task | After |
|---|---|---|---|
| I | api | A `records` table with an arrival number; `POST /v1/parcels`: decode, verify with the core's Python build, store once, answer per record (design section 7, intake steps 1 to 3 and 5, no budgets, no derivations yet). The OpenAPI document | none; independent of A to H |
| J | api | `GET /v1/records`: the feed for a player after a cursor, with the placement rule of section 6 | I; B for the Python getters |
| K | web-client | `storage.ts`: `heldRecords`, `markAnswered`, `storePulled`, the cursor | D |
| L | web-client | `src/api/parcels.ts`, `src/api/records.ts`, `src/sync.ts`, started from `main.tsx` | I, J (for the generated types), K, E |
| M | web-client, e2e | "Saved on this device" and "Synced" on the pages; one cross-app test | L |
| N | api | The event stream, with `LISTEN`/`NOTIFY` | J |
| O | web-client, e2e | `src/live.ts`, and the stream through the Worker in the cross-app suite | L, N |

I and J can be built while A to H are. Nothing in A to H changes when sync arrives: the store, the pages and the announcement are already the path a pull uses.

## 10. How to prove it

Claims first, each at the narrowest seam that contains it. MSW stands in for the api in component tests, as everywhere in the web client; the browser suites never mock it.

| # | Claim | Seam | The test asserts |
|---|---|---|---|
| 1 | The same set of records gives the same match state in any order, with repeats | Pure rule, core (`core/tests/`, vectors) | Every permutation of a fixed set, some doubled, derives equal state |
| 2 | An entry named as replaced is not shown; of two current entries the rule of question 3 picks one, and the game is contested | Same | One case each, as vectors both bindings check |
| 3 | A record, its journal row, its summary and the revision are kept together or not at all; a record is kept once | One app as it ships: `e2e/tests/storage.spec.ts` through `e2e/harness/storage.html` (jsdom has no IndexedDB) | After a write that is made to fail, none of the four is there; after the same record twice, one of each |
| 4 | A database from version 1 keeps its hello, its user and the `me` pointer after the upgrade | Same | Seed version 1, open the new build, `loadMe` gives the same user |
| 5 | The cursor is never ahead of the records | Same | After `storePulled` is made to fail, the cursor is the old one |
| 6 | A score appears only after its write succeeded | Service: `src/matches/store.test.ts`, with `storage.ts` and `journal.ts` replaced at their interfaces | With the commit held open, the entry is unchanged; released, it has the new score; failing, it is unchanged with the failure set |
| 7 | A reload that began before a write cannot remove the point | Same | Start a reload, start `scorePoint`, let the reload's read resolve last: the entry ends with the point |
| 8 | A change reloads a watched match, deletes an unwatched one, ignores an unnamed one and an old revision | Same | One case each, counting nothing: by the entry's content after |
| 9 | Becoming visible reloads what is watched | Same | The entry changes after a `visibilitychange` with new data in storage and no message |
| 10 | A tap with an old `from` writes nothing and says the score changed | `src/journal.ts` and the draft, in the browser suite harness (real key, real storage) | No new record; the result is `changed` |
| 11 | Two tabs tapping at once never fork a game | Browser suite, two pages | After both taps, the game has one current entry and two points |
| 12 | An announcement reaches the posting tab and other tabs | Pure: `changes.test.ts` with a stand-in channel; the real channel is covered by claim 14 | The listener got the change once |
| 13 | Each screen shows each state it can be given (score, saving, each failure, contested, changed) | One app in process: `<Name>Screen.test.tsx`, props only, page object | One case per state |
| 14 | **The details page changes on screen when a record is written from outside** | **Needs a real browser and two tabs**: `web-client/e2e/tests/match-live.spec.ts` | Tab A is on the details page; tab B scores a point; tab A shows the new score with no reload, and the control that had focus in A still has it |
| 15 | The connected details component replaces its data without a pending state | One app in process: `MatchDetails.test.tsx`, real store, `storage.ts` replaced | After a change, the new score shows and the pending view never did |
| 16 | The list gains a row when a match is written from outside; a page showing no match does nothing | Same seam, `MatchList.test.tsx`; and for "does nothing", claim 8 | The new row is there and the row that had focus still has it |
| 17 | A route shows its page, and an unknown match id shows not found | Route test, `renderRoute` | One case each |
| 18 | A cycle sends held records in journal order, scores last, and marks each by its answer | Service: `src/sync.test.ts`, MSW for the api, `storage.ts` replaced | The body the api received; the answers passed to `markAnswered` |
| 19 | A damaged parcel stores nothing and leaves the cursor; a record that doesn't verify is skipped and the cursor moves | Same, with the real core | What `storePulled` was given |
| 20 | With no connection a cycle changes nothing and tries again when it returns; cycles run on the triggers of section 6 | Same, fake timers, as `new-version.test.ts` | No write; a request after `online` |
| 21 | Only one tab runs a cycle at a time | **Needs a real browser and two tabs**, with the api held back | One request while both tabs ask |
| 22 | The client and the api agree on the two endpoints' shapes | Static: `web-client:api-types-check` and `web-client:typecheck` | Nothing runs |
| 23 | Intake stores a valid record once, stores one whose match is unknown, and stores nothing for a bad signature | Service, api: `api/tests/services/`, real PostgreSQL | The rows after |
| 24 | The feed gives a player's records after a cursor in order, and a score that arrived before its match is not lost | Same | Store score, then match; pull from a cursor between them |
| 25 | Each endpoint's outcomes map to their status and document | `api/tests/http/`, one case per outcome | Status and the OpenAPI check |
| 26 | A point scored on one device shows on another | Assembled stack, the one test for this journey: `e2e/`, two browser contexts | Device A scores; device B's details page shows it |
| 27 | The event stream passes the Worker | Assembled stack (hosting counts as wiring) | An event arrives at the page within seconds of a record being stored |
| 28 | A mid-match reopen with no connection shows the score and takes a point | Browser suite, `context.setOffline(true)` | The score after reopening; one more point after a tap |

Not proven by any test: how the pages look (by eye; screenshots are for `/design-system/*` only), that scroll position survives a replace (claim 14 proves focus; scroll by eye), and tap-to-paint time on a real phone.

## 11. Questions only the user can answer

1. **Is sync (tasks I to O) part of this epic?** You said on 2026-11-12 that the first epic is everything on the device with no backend sync. Recommendation: build A to H now, and I to M next. The design above is fixed either way, so H does not change when sync lands.
2. **What do a match's terms and a score hold, and how is the opponent named?** Both layouts are permanent once released. Recommendation: terms are a version, best-of (games) and points per game; a score value is a version and two counts for one game, absolute. For the opponent in the local-only epic: a `player` record this device creates ("an extra player managed by the signer's account"), which the design says counts only once the account is approved, so it is fine on the device and settled properly when identity lands.
3. **When two devices score the same game at once, which score shows?** Recommendation: the entry with the most points in total, ties broken by record id; the page says another device is also scoring; the next point from either closes the fork. And a tap made on a score that has since changed is refused and asks the person to tap again, so one point is never counted twice.
4. **Who may pull a player's records?** The door in takes no credentials by design (P3); the design does not say who may read. Recommendation: for development and previews, any device may ask for any player's feed; decide the real rule with identity, before production has an api address.
5. **How fresh must a match someone is watching be?** Recommendation: a pull every 15 seconds while it is on screen. Server-sent events later, as a trigger only, if that is too slow (section 8), knowing an open stream keeps a Cloud Run instance billed.
6. **May a small connected component read the store?** It needs a line in `web-client/CLAUDE.md`: a page that shows live data is a connected component (`MatchDetails.tsx`: store hooks, no markup) around a screen that takes props. Recommendation: yes. The alternative, a screen that reads the store itself, makes every screen test set up a store.

## 12. Where this departs from the earlier documents

- **`PLAN-offline-scoring.md` section 5** replaces a temporary score by comparing a `baseRev` with the server's revision. This plan uses the design's rule (an entry names what it replaces), since the design says it wins and the rule needs no server.
- **Design section 14** puts "which records to send next, how to apply a server reply" in the core. Here they are a few lines of TypeScript in `sync.ts` and `storage.ts` (journal order, scores last; a state per answer). There is one client today. They move into the core when a second platform needs them, behind the same functions.
- **Design section 5** says records pulled from the server go through the same intake as a scanned code and become held. Here a pulled record is stored as acknowledged at once: the server sent it, so it holds it. A scanned record (later) is held.
- **Design section 5.4** lets another tab take over a sync lock from a suspended tab after a timeout. Not built: requests time out, so a cycle is short, and an overlap would be harmless anyway (L3).
- **Design section 7's pulled view** (outcome states, tags, identity state, the stamp) is not in the first pull. Matches and scores need none of it.
- **The brief's "a pull, and a push if needed".** The design makes them one cycle, send first. This plan keeps that.
- **The store is a second cache.** The design's views are caches computed from the journal. The zustand store is a copy of a view, in memory, for mounted pages only. It holds nothing that can't be dropped at any moment.

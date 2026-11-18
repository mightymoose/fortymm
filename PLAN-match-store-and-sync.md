# The stores and background sync: design plan

Status: planning only, nothing implemented. Written 2026-11-14 for the web client, and revised the same day with the user's answers (section 11).
It follows `DESIGN-primitives.md` (called "the design" below) and, where the design is silent, `PLAN-offline-scoring.md`. Section 12 lists where it departs from either, and why.

**What to build now:** task 0 and tasks A to H of section 9, everything on the device. Sync (tasks I to O) is designed here so that nothing in 0 to H has to change when it arrives, and is not to be built yet.

## 1. Summary

Two pieces.

1. **The stores.** Several small in-memory zustand stores in front of IndexedDB: `user`, `myMatches`, and `match`, keyed by match id. A page reads a store and calls its actions. A store never holds anything that isn't on disk: every value in it was read from IndexedDB, after the write that produced it finished. No `persist`.
2. **Sync (later).** One cycle that sends this device's unsent records and then pulls new ones. Pulled records are verified by the core, written through `storage.ts`, and announced. The cycle never touches a store.

One rule joins them: **every write to `fortymm-storage` is announced, and every announcement makes each tab's stores reload from IndexedDB what its mounted pages are reading.** A local tap, the first launch, a pull, another tab and (later) a live stream all reach the screen by that one path.

```
tap ─▶ store action ─▶ journal.commit ─▶ storage (one transaction) ─▶ announce ─┐
pull / stream ─▶ core verifies ─▶ storage (one transaction) ─▶ announce ────────┤
                                                                                ▼
                         every tab: stores reload what is watched from IndexedDB ─▶ screen
```

What exists today: `storage.ts` keeps hellos only; `/settings` reads this device's user through a loader (`ownAccount`); the core's browser build makes one kind of record (hello) and has no rules; the api serves `GET /v1/health` and nothing about records. (`origin/apply-match-records` has a temporary match endpoint and an older core wrapper. It is not on `main` and this plan does not build on it.)

Scope: this device's user, and `match` and `score` records, the temporary scores of design section 4. Signing a result (`result` records, the QR handover) uses the same stores, storage and sync paths; its screens are a later plan.

## 2. Modules and who owns what

**Reads and writes both go through a store.** A component, a route or a loader never calls `storage.ts`, the core or the device key. To read, it uses a store's hook; to write, it calls a store's action. The action calls the core and `storage.ts` (through `journal.commit`), and only when the write has succeeded does the store update, by reading IndexedDB again. There is no optimistic update: a failed write leaves the store exactly as it was, and the action returns the typed failure.

| Module | Owns | Never does |
|---|---|---|
| `src/storage.ts` (widened) | The `fortymm-storage` database: record bytes, the journal's order and states, the rows minted from records, the pull cursor. Calls the core to read records and derive match state. Announces each write it commits. | Network, the key, React |
| `src/changes.ts` (new, task 0) | Telling this tab and the others what changed: one `BroadcastChannel`, one message type. | Read or write data |
| `src/stores/user.ts` (new, task 0) | This device's user, and starting the first launch. | |
| `src/stores/my-matches.ts` (new) | The list of this device's matches, and creating one. | |
| `src/stores/match.ts` (new) | One entry per match id: its state, and the scoring actions. | |
| `src/journal.ts` (new) | `commit`: the only way a store makes a record. Builds the body with the core, signs with the device key, stores through the held store, all inside one `withDeviceKey` callback. | Decide what a tap means; touch a store |
| `src/first-launch.ts` (as now) | Making this device's key, hello and user. Called by the `user` store's `launch` action. | |
| `src/sync.ts`, `src/stores/sync.ts`, `src/api/parcels.ts`, `src/api/records.ts` (later) | The sync cycle, its status for pages, and the two api calls. | Write to a store's data; write to IndexedDB except through `storage.ts` |
| `src/live.ts` (later, last) | The server-sent events connection (section 8). It only asks `sync.ts` to run a cycle. | Carry records; write anything |

Routes stay thin: a path, a loader that awaits one store's load, one component.

**Why several stores.** Each holds one kind of thing, with its own actions and its own listener on the one announcement, so a page subscribes only to what it shows and a store's test sets up only that store. Three are enough for tasks 0 to H. A fourth, `sync` (the cycle's status, for "Synced"), comes with sync. No store is needed for other players: a match's state already carries its players' usernames. Add a store when a page needs data none of these holds, never to share state between components.

**What every store has in common.**

- **One queue per store.** Every job that sets the store's state runs on one promise chain, one at a time: a local action (commit, then reload) and a reload caused by a change. A reload that began before a write can therefore never land after it and wipe a point off the screen. The helper is a few lines, in `src/stores/queue.ts`.
- **A reload is the only thing that sets data.** It calls a `storage.ts` read and replaces the state. A local action ends with the same reload. One code path from disk to screen, nothing to roll back.
- **It listens with `onChange`** and reloads only what a mounted page is watching (each store's rule is below).
- It is made with zustand's vanilla `createStore` and exported with its hooks, so a test can build a fresh one.

### `src/changes.ts`

```ts
type Change = {
  account: boolean           // this device's user or its name changed
  matches: string[] | 'all'  // match ids (hex) the write touched; 'all' past 20, and for an upgrade
  revision: number           // storage's change counter after the write (from task D; 0 before)
}
function announce(change: Change): void                      // this tab's listeners, then the channel
function onChange(listener: (change: Change) => void): () => void
```

- A `BroadcastChannel` named `fortymm-changes`. The browser doesn't deliver a message to the tab that posted it, so `announce` calls this tab's listeners itself first.
- Only `storage.ts` calls `announce`, after a write transaction completes. No writer can forget.
- A message can be missed (a frozen tab, a page restored from the back/forward cache). So `changes.ts` also gives its listeners `{ account: true, matches: 'all' }` when the page becomes visible and on `pageshow`. A missed message costs one reload on return, never a wrong screen.

### `src/stores/user.ts`

```ts
type UserState =
  | { status: 'unread' }
  | { status: 'user'; user: User }
  | { status: 'none' }                    // no first launch yet, or it failed
  | { status: 'storage-unavailable' }

load(): Promise<void>      // for loaders: resolves once the user has been read
watchUser(): () => void    // a mounted page is showing the user
useUser(): UserState
launch(): Promise<void>    // main.tsx, after the first paint: the first launch, then a reload
```

- `load` is today's `ownAccount` (`src/account.ts`, which goes away): one `loadMe()`; with no user while the launch at startup is running, it waits for it, bounded by `startupLaunchSettled()`, and reads again. It makes nothing.
- `launch` calls `firstLaunch()` and sets the `fortymm:first-launch` mark as `launchAtStartup` does today, then reloads. The first paint still never waits for it.
- On a change with `account: true`, it reloads if watched, and goes back to `unread` if not.
- This is the only store a page needs to know who "me" is. `my-matches.ts` reads the own player id inside its commit, from storage, not from this store.

### `src/storage.ts`

Task 0 changes one thing: a write that stores a user or the `me` pointer announces `{ account: true, matches: [], revision: 0 }`. The rest is task D: database version 2. Version 1's stores stay as they are.

| Store | Key | Holds |
|---|---|---|
| `records` (as now) | record id | the signed bytes |
| `journal` (new) | `seq`, auto-increment | `{ id, match: hex or null, kind, state: 'held' or 'acknowledged' or 'stuck', own: boolean }`; indexes on `id` (unique), `match`, `state`. The counter of design 5.4 and the states of design 5 |
| `matches` (new) | match id | `MatchSummary`, a copy for the list, rewritten in the same transaction as every record of that match |
| `sync` (new) | fixed names | `revision` (a counter every write transaction raises by one) and, later, `cursor` (section 6) |
| `users`, `me` (as now) | | |

The upgrade from 1 adds the stores and gives each record already kept (hellos) a `journal` row, held. It runs in the upgrade transaction, so it happens whole or not at all.

```ts
// Reads: no lock, one transaction each.
loadMatch(matchId): Promise<{ ok: true; match: MatchState | null; revision: number } | Unavailable>
loadMatches():      Promise<{ ok: true; matches: MatchSummary[]; revision: number } | Unavailable>
// Added to the held Store (inside withDeviceKey only):
store.loadMatch(matchId)                 // same answer, for a commit to read what is current
store.loadMe()                           // this device's user, for a commit that names it
store.append(record)                     // a record this device made: held, own
// Later, for sync (each takes the append lock itself):
heldRecords(limit)                       // journal order, scores after everything else (J7)
markAnswered(answers)                    // held -> acknowledged or stuck, by record id
storePulled(records, cursor)             // { ok: true; kept: number; rejected: number } | ...
loadCursor()

type Unavailable = { ok: false; reason: 'storage-unavailable' | 'core-unavailable' }
```

- `MatchState` is what a page shows, derived by the core from the match's records (task C): the sides with their usernames, the terms, each game's shown score, the ids of the current entries per game, and `unsent`, how many of this match's records are still held. Ids are hex; no bytes leave `storage.ts`.
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

### `src/stores/my-matches.ts`

```ts
type MyMatchesState =
  | { status: 'unread' }
  | { status: 'ready'; matches: MatchSummary[]; revision: number }
  | { status: 'unavailable'; reason: 'storage-unavailable' | 'core-unavailable' }

load(): Promise<void>
watchMyMatches(): () => void
useMyMatches(): MyMatchesState
createMatch(opponent, terms): Promise<ActionResult & { matchId?: string }>
```

On a change that names any match (or `'all'`) with a newer revision: it reads the summaries again if watched (one small read), and goes back to `unread` if not.

### `src/stores/match.ts`

```ts
type MatchEntry =
  | { status: 'ready'; match: MatchState; revision: number; saving: number; failure: Failure | null }
  | { status: 'missing' }                       // no match record on this device
  | { status: 'unavailable'; reason: 'storage-unavailable' | 'core-unavailable' }

// state: { matches: Record<string, MatchEntry> }
load(matchId): Promise<MatchEntry>              // for loaders
watchMatch(matchId): () => void
useMatch(matchId): MatchEntry | undefined
scorePoint(matchId, game, side): Promise<ActionResult>
setGameScore(matchId, game, value: [number, number]): Promise<ActionResult>   // typed entry, undo

type Failure = { reason: 'storage-unavailable' | 'locks-unavailable' | 'signing-unavailable' | 'core-unavailable' }
type ActionResult = { ok: true } | ({ ok: false } & Failure)
```

- **Only watched matches reload.** On a change, a named match that a mounted page is watching is reloaded. A named match nobody is watching has its entry deleted; the next page that opens it reads it fresh through its loader. An unnamed match is left alone.
- **Revisions drop stale work.** A change whose `revision` is not above the entry's is ignored. This is also what makes the tab's own announcement, arriving after its action already reloaded, cost nothing.

## 3. A local action, step by step

`scorePoint(matchId, game, side)` in the `match` store.

1. The action joins the store's queue. The entry's `saving` goes up by one (the control shows it is working; the score does not change).
2. `journal.commit` takes the append lock and the device key.
3. Inside the lock, the draft reads the match with `store.loadMatch`, and builds a `score` record for that game with the new absolute value (never an increment, `PLAN-offline-scoring.md` section 5): the game's score on disk plus the point. It names as replaced every entry current for the game.
4. Sign, assemble, `store.append`: the record, its journal row, the summary and the revision in one strict transaction.
5. The lock is released. `storage.ts` announces `{ revision, matches: [matchId], account: false }`.
6. Still inside the queue job, the store reloads the match from IndexedDB and replaces the entry. `saving` goes down. The promise resolves `{ ok: true }`.
7. This tab's `myMatches` store and the other tabs' stores get the change and reload what their pages are watching.

No optimistic update. A tap costs a signature, one strict write and one read: tens of milliseconds. If tap-to-paint measures above 100 ms on a mid-range phone, revisit; until then the simple rule holds.

| Failure | What is kept | The store | What the screen shows |
|---|---|---|---|
| `storage-unavailable`, `locks-unavailable` | Nothing | As it was, with `failure` set | The score unchanged, and an alert on the page: "That point wasn't saved. This browser isn't letting FortyMM store data." It stays until the next action succeeds |
| `core-unavailable` (the module didn't load) | Nothing | The same | The score unchanged: "That point wasn't saved. Reload and try again." A load that fails is forgotten, so the next tap tries again |
| `signing-unavailable` | Nothing | The same | As storage, naming signing |
| The tab is closed mid-write | The whole record or none (J3) | Gone with the tab | On reopening, what is on disk |
| No network | The record, held | Updated | The score. Nothing in tasks 0 to H needs a network |

`createMatch` in `myMatches` is the same flow with two records in one commit: a `player` record for the opponent, then the `match` record naming this device's own player (read inside the lock with `store.loadMe`) on one side and the new player on the other (section 11, answer 2). The user store's `launch` is the same shape too: `firstLaunch()` writes, storage announces `account: true`, the store reloads.

## 4. Pages: what each subscribes to, and what a change does

"What should happen" is the page's decision. A store only guarantees that what a mounted page watches is current.

| Page | Watches | When a record for its data lands (a local action, another tab, later a pull) | For anything else |
|---|---|---|---|
| Match details, `/matches/$matchId` | That match (`match`) | The entry is replaced; the page shows the new score in place | Nothing |
| Scoring, `/matches/$matchId/score` | That match (`match`) | The same | Nothing |
| Match list, `/matches` | The list (`myMatches`) | The summaries are read again; rows are keyed by match id, so one row changes or one is added and the rest don't re-render | Nothing |
| Settings, `/settings` | The user (`user`) | For `account: true`: the user is read again, and the page shows it. A page that said "no account yet" shows the username when the launch finishes, with no reload | Nothing for a match |
| Every other page | Nothing | Nothing. Match entries nobody watches are dropped | Nothing |

**Loaders and subscriptions.** The loader makes sure the data is in the store; the page subscribes for what comes after.

- The route's loader awaits the store's `load` (`load(params.matchId)`), so the router's pending component covers the first read, and a `missing` match becomes `notFound()`. It returns nothing: store data is never copied into loader data, where it would go stale.
- The page then reads with the store's hook and calls its watcher in an effect while mounted.
- Store data is never refreshed with `router.invalidate()`. Invalidation reruns loaders and can show pending states; a subscription replaces the data under a mounted page with neither.

**Where the subscription lives (answer 6: yes).** Each page that shows store data gets one small connected component in `src/components/`: `MatchDetails.tsx` reads the store (`useMatch`, `watchMatch`) and renders `MatchDetailsScreen` with plain props (`match`, `saving`, `failure`, `onScorePoint`). The route's component is the connected component, handed `matchId` by the wrapper. The screen stays a pure function of its props, tested as screens are today; the connected component is tested once against a real store. Task 0 adds this to `web-client/CLAUDE.md`, under "Route files are cheap wiring; screens are components", in "Where neither list fits, these are decided":

> - **A page that shows data kept on this device is a connected component around its screen.** `src/components/<Name>.tsx` (`Settings.tsx` around `SettingsScreen`) reads a store in `src/stores/` with its hook, calls the store's watcher while mounted, and renders the screen with plain props and the store's actions as callbacks. It holds no markup, no state and no logic of its own. The route's loader awaits the store's `load` and returns nothing, and the route's `component` is the connected component. A screen never reads a store. Reads and writes of this device's data go through a store and its actions: no component, route or loader calls `storage.ts`, the core or the device key.

**What the person sees while data is replaced.**

- No flash. A store keeps its old data while a reload reads; it is swapped in one `set`. Nothing shows a loading state after the first load.
- Scroll and focus stay. The same components stay mounted; lists are keyed by match id and games by game number, so React changes text, not elements.
- A score that changes mid-entry. In a typed form (a game entered as 11-7), the draft lives in the form's own state, which a store update doesn't touch; the score beside it changes. Whether a tap or a submit made on a score that has since changed should be refused belongs to answer 3, not decided yet: don't build it. In tasks 0 to H the only other writer is another tab of the same device, and a commit adds to what is on disk inside the lock, so no point is lost.

## 5. Conflicts

The design settles most of this.

| Case | Rule | Source |
|---|---|---|
| A duplicate (the same record written twice, by two tabs, or later pulled after being made here) | A record is keyed by its id and kept once. The second write changes nothing | Design 4.2, L3; `storage.ts` today |
| One body with two signatures | One id, the same record; the first kept stays | `storage.ts` today |
| Out of order (a score before its match, a newer score before the one it replaces) | Records are a set. The state is derived from the set, never from arrival order. A score is stored before its match is known and shows once the match arrives | Design L2, L4 |
| A stale score arriving late | An entry replaces only the entries it names, so it cannot displace a newer one | Design 7.2, last row |
| Two tabs of one device | Cannot fork: each commit reads what is current inside the append lock | Section 3, step 3 |
| Two devices scoring the same game without seeing each other | Both entries are *current* (neither names the other). Which to show: **not decided yet, don't build** | Design section 7, Scoreboard; answer 3 |
| A record the core rejects | Not stored | Design R1 |

**The placeholder tasks 0 to H need for two current entries.** It cannot happen on one device, but `matchState` must return a score for any set of records. So task C picks, of several current entries for a game, the one with the highest record id: deterministic, no clock, and plainly arbitrary. It is marked as a placeholder in the code and in `FORMAT.md`, has no golden vector (vectors are permanent after release), no "contested" field in `MatchState` and nothing on screen. The real rule replaces it before sync is built.

Results and their conflicts (two signed results, corrections, the seen list) are settled by design section 7 and are outside this plan.

## 6. Sync: one cycle, send then pull (later; not in tasks 0 to H)

**Pushing is part of the same job.** The design's sync loop is one cycle: send held records as a parcel, mark what the server acknowledges, then pull (design section 5). Sending first means the pull that follows already includes the device's own records as the server ordered them.

```ts
type SyncStatus =                           // the `sync` store's state
  | { state: 'off' }                        // no account yet
  | { state: 'idle'; unsent: number }
  | { state: 'running'; unsent: number }
  | { state: 'waiting'; unsent: number; why: 'offline' | 'server' | 'storage' | 'core' }

function startSync(): { now(): void; stop(): void }   // main.tsx, after the first paint
```

**One cycle.** Inside the Web Lock `fortymm-journal-sync`, requested with `ifAvailable`: if another tab is in a cycle, this one does nothing (J2).

1. `heldRecords(100)`. If any: build a parcel with the core, `POST /api/v1/parcels`. The answer names each record: held, applied, refused, retry later or malformed. `markAnswered` moves held and refused to acknowledged (the server holds them) and malformed to stuck, in one transaction, and announces the matches touched, so "saved" changes on screen. Retry-later records stay held.
2. `loadCursor()`, then `GET /api/v1/records?player=<own player id>&after=<cursor>`.
3. The answer is a parcel, a new cursor and `more`. `core.parse`; a damaged parcel stops the cycle with nothing stored. Each record is verified (`core.verify`); one that fails is counted and skipped.
4. `storePulled(records, cursor)`: the records (acknowledged at once), their journal rows, the summaries, the revision **and the new cursor** in one transaction inside the append lock. Then `storage.ts` announces the matches touched, and the stores reload as for any other write.
5. While `more` is true or records are still held, go again, at most 10 rounds; then release the lock.

Each request has a timeout, so a cycle holds the lock for a bounded time.

**The cursor.** Opaque text from the server: the arrival number of the last record sent (design 7, "arrival number"; design 5, "the pull asks only for records that arrived after the last one the device has seen"). It is kept in the `sync` store of the database and written in the same transaction as the records it covers, so it can never run ahead of what is on disk. Not in `localStorage`: that could not be written with the records. If storage is wiped, the cursor goes with it and the next pull starts from the beginning.

**A gap: a record that becomes this device's business after the cursor passed it.** A score can reach the server before its match record (design L2). A feed of "records of my matches, after arrival number N" would skip it for ever once N has passed it. Smallest rule: the server gives a record its place in a player's feed when it first becomes attributable to one of that player's matches, not when it arrived; in practice, when a match record is stored, the records already held for that match are placed in the feed after it. The cursor stays one number.

**Who may pull a player's feed: not decided yet (answer 4), don't build.** Tasks 0 to H need nothing for it. It must be answered before task J.

**What the first pull does not carry.** The design's pulled view also has outcome states, each match's tags, identity state and the stamp. None is needed for matches and scores. They join the same answer later; the client flow doesn't change.

**When a cycle runs** (in the page, like `new-version.ts`): at startup once the first launch has settled; two seconds after a local commit (so a rally of taps is one parcel); when the page becomes visible; when the connection returns; every 15 seconds while a match is watched and the page is visible (answer 5), every 5 minutes otherwise. After a failure it waits 5 seconds, doubling to 5 minutes, with jitter; a success or `online` resets it. Background Sync in the service worker is not built: it is Chromium only, and the design calls it a bonus.

| Failure | What happens | What the screen shows |
|---|---|---|
| No network, a timeout, 5xx, 429 | Nothing is written. Held records stay held, the cursor stays. Backoff | Scores as they are, "Saved on this device". No error: nothing is wrong |
| `storage-unavailable` on any step | The cycle stops. Nothing half-written: each step is one transaction | Whatever the page's own reads and actions already show for storage |
| `locks-unavailable` | No cycle ever runs: without locks there is no single writer | As above. Such a browser has no account either |
| `core-unavailable` | No cycle; the next trigger loads the core again | Nothing extra |
| The pulled parcel is damaged | Nothing stored, cursor unchanged, backoff, retried | Nothing |
| One pulled record doesn't verify | Skipped; the rest of the page is stored and the cursor moves past it, or the device would ask for it for ever. Counted in `storePulled`'s `rejected` | Nothing. This is a server defect, logged to the console |
| The server calls one of our records malformed | It becomes stuck: kept, never sent again | "1 score couldn't be sent" on the match. The design says this is a defect and should be unreachable |
| The tab closes mid-cycle | The lock is released by the browser. Sent records not yet marked are sent again; the server answers as it did the first time (L3) | Nothing |

## 7. What "saved" means, and startup

**Saved.** Because a store only shows what was read from disk, everything on screen is saved on this device. The screen never has an unsaved score to mark. In tasks 0 to H a match shows one of two things: the tapped control busy while `saving > 0`, and otherwise "Saved on this device". With sync, `match.unsent === 0` after a cycle shows "Synced", and a stuck record shows the message of section 6.

**Startup.** Nothing is loaded eagerly and nothing is rebuilt: every store starts unread, and the first page's loader reads what that page shows. `main.tsx` renders, then calls the user store's `launch()` in the background, as it calls `launchAtStartup()` today.

**Reopening mid-match with no connection.** The service worker serves the app and the core's module. The loader's `load(matchId)` reads the match's records and derives the state: the score is exactly what was on screen when the tab closed, since nothing was ever shown before it was on disk. Scoring goes on. Nothing on the page says anything is wrong, and with sync, the first cycle fails quietly and waits for `online`.

## 8. Server-sent events (later; after sync)

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

So: polling first, at 15 seconds (answer 5). The stream is tasks N and O. It changes no earlier task; when it lands, the timer while watching can relax to a minute.

## 9. What has to be built, in order

Each line is one worker and one pull request. "After" names what must be merged first.

### Now: the epic, everything on the device

| # | App | Task | After |
|---|---|---|---|
| 0 | web-client | The user behind a store. Adds the `zustand` dependency, `src/changes.ts`, `storage.ts` announcing `account` changes, `src/stores/queue.ts`, `src/stores/user.ts`, the connected `Settings.tsx`, and the line for `web-client/CLAUDE.md` (section 4). Details below | none. Independent of A to C |
| A | core | The two product layouts the core carries as opaque bytes today: match terms and the score value, each with a version (`FORMAT.md`, `layout.rs`), with a function to write and one to read each. Uses the working assumption of answer 2 | none |
| B | core | In the browser and Python builds: `playerBody`, `matchBody` and `scoreBody` (the `Draft` constructors exist in Rust), `kind`, the match a record is about, and a score's game, value and replaced ids. Vectors | none. Independent of A |
| C | core | The rules: `matchState(records)`: which entries are current, the shown score per game (with the placeholder of section 5), the current ids. A pure function of the set, with golden vectors for everything but the placeholder | A, B |
| D | web-client | `storage.ts` version 2: the stores of section 2, the upgrade, `store.append`, `store.loadMe`, `loadMatch`, `loadMatches`, the revision, and announcing matches. It accepts `player`, `match` and `score` records | 0, B, C |
| E | | Folded into 0 (`changes.ts`) and D (announcing matches). No task of its own | |
| F | web-client | `src/journal.ts`: `commit` | D |
| G | web-client | `src/stores/my-matches.ts` and `src/stores/match.ts`, with their actions | D, F. Can start against `storage.ts` and `journal.ts` replaced at their interfaces once D is merged |
| H1 | web-client | Create a match, and the match list page | G |
| H2 | web-client | The match details page, and the two-tab browser test | G |
| H3 | web-client | The scoring page | G |

Independent of each other: 0, A and B. H1, H2 and H3.

**Task 0 in full.** It moves what exists; no screen looks different.

- `src/account.ts` and its test go away. Its logic is the user store's `load` (`src/stores/user.ts`, tested in `src/stores/user.test.ts` with `storage.ts` replaced, as `account.test.ts` does now).
- `/settings`: the loader becomes `loader: () => userStore.getState().load()`, returning nothing; the route's component becomes `Settings` (`src/components/Settings.tsx`), which reads `useUser()`, calls `watchUser()` while mounted, and renders `SettingsScreen` with the same props as today. `SettingsScreen`, its page object and its test don't change. The pending view still covers the first read.
- What is new for a person: `/settings` updates itself. A page that said "no account yet" because the launch was held past the bound shows the username once the launch finishes, in this tab or another, with no reload.
- `main.tsx` calls `userStore.getState().launch()` where it calls `launchAtStartup()`. `first-launch.ts` keeps `firstLaunch()`, the mark and `startupLaunchSettled()`; only who calls them changes. The device key is still used only inside `firstLaunch()` (and later `journal.commit`); no component or route reaches it, now by rule.
- No other route changes: `/`, `/health` and `/design-system/*` read nothing from this device's storage.
- `web-client/README.md` gains a short "The stores" section and updates "The account settings page" and "The first launch".

### Later: sync, then the stream. Don't build yet

| # | App | Task | After |
|---|---|---|---|
| I | api | A `records` table with an arrival number; `POST /v1/parcels`: decode, verify with the core's Python build, store once, answer per record (design section 7, intake steps 1 to 3 and 5, no budgets, no derivations yet). The OpenAPI document | none |
| J | api | `GET /v1/records`: the feed for a player after a cursor, with the placement rule of section 6 | I; B; answer 4 |
| K | web-client | `storage.ts`: `heldRecords`, `markAnswered`, `storePulled`, the cursor | D |
| L | web-client | `src/api/parcels.ts`, `src/api/records.ts`, `src/sync.ts`, `src/stores/sync.ts`, started from `main.tsx` | I, J, K; answer 3, replacing the placeholder in C |
| M | web-client, e2e | "Synced" on the pages; one cross-app test | L |
| N | api | The event stream, with `LISTEN`/`NOTIFY` | J |
| O | web-client, e2e | `src/live.ts`, and the stream through the Worker in the cross-app suite | L, N |

Nothing in 0 to H changes when sync arrives: the stores, the pages and the announcement are already the path a pull uses.

## 10. How to prove it

Claims first, each at the narrowest seam that contains it. MSW stands in for the api in component tests, as everywhere in the web client; the browser suites never mock it.

### Task 0

| # | Claim | Seam | The test asserts |
|---|---|---|---|
| U1 | The user store gives the user, none, or storage-unavailable, as `loadMe` answers | Service: `src/stores/user.test.ts`, `storage.ts` replaced | One case per answer |
| U2 | With no user while the launch is running, `load` waits for it (bounded), reads again, and makes nothing | Same | The second read's user; no write was asked for |
| U3 | After an `account` change, a watched user is read again; an unwatched one goes back to unread | Same | The state after the change |
| U4 | An announcement reaches the posting tab's listeners and the channel, once each | Pure: `src/changes.test.ts`, a stand-in channel | What each listener got |
| U5 | The connected settings page shows the username when the store gets one, with no pending view | One app in process: `src/components/Settings.test.tsx`, a real store, `storage.ts` replaced | "No account yet", then the username after a change |
| U6 | `/settings` shows its screen with the store's user, and its pending view while the first read runs | Route test, `renderRoute`, as now | One case each |
| U7 | What the shipped app did before, it still does | One app as it ships: `e2e/tests/first-launch.spec.ts` and `settings.spec.ts`, unchanged | They pass untouched |
| U8 | **A `/settings` page that said "no account yet" shows the username when the held launch finishes** | **Needs a real browser and two tabs**: `settings.spec.ts`, extending its case where another tab holds the lock | Release the lock; the username appears with no reload |

### Tasks A to H

| # | Claim | Seam | The test asserts |
|---|---|---|---|
| 1 | The same set of records gives the same match state in any order, with repeats | Pure rule, core (`core/tests/`, vectors) | Every permutation of a fixed set, some doubled, derives equal state |
| 2 | An entry named as replaced is not shown | Same | One case, as a vector both bindings check |
| 3 | A record, its journal row, its summary and the revision are kept together or not at all; a record is kept once | One app as it ships: `e2e/tests/storage.spec.ts` through `e2e/harness/storage.html` (jsdom has no IndexedDB) | After a write that is made to fail, none of the four is there; after the same record twice, one of each |
| 4 | A database from version 1 keeps its hello, its user and the `me` pointer after the upgrade | Same | Seed version 1, open the new build, `loadMe` gives the same user |
| 5 | A score appears in the store only after its write succeeded; a failed write leaves the entry as it was and returns the failure | Service: `src/stores/match.test.ts`, with `storage.ts` and `journal.ts` replaced at their interfaces | With the commit held open, the entry is unchanged; released, it has the new score; failing, it is unchanged with `failure` set |
| 6 | A reload that began before a write cannot remove the point | Same | Start a reload, start `scorePoint`, let the reload's read resolve last: the entry ends with the point |
| 7 | A change reloads a watched match, deletes an unwatched one, ignores an unnamed one and an old revision | Same | One case each, by the entry's content after |
| 8 | Becoming visible reloads what is watched | Same, and `changes.test.ts` | The entry changes after a `visibilitychange` with new data in storage and no message |
| 9 | Creating a match adds it to a watched list; a change naming a match rereads the list | Service: `src/stores/my-matches.test.ts` | The list after |
| 10 | Two tabs tapping at once never fork a game and lose no point | Browser suite, two pages | After both taps, the game has one current entry and two points |
| 11 | Each screen shows each state it can be given (score, saving, each failure) | One app in process: `<Name>Screen.test.tsx`, props only, page object | One case per state |
| 12 | **The details page changes on screen when a record is written from outside** | **Needs a real browser and two tabs**: `web-client/e2e/tests/match-live.spec.ts` | Tab A is on the details page; tab B scores a point; tab A shows the new score with no reload, and the control that had focus in A still has it |
| 13 | The connected details component replaces its data without a pending state | One app in process: `MatchDetails.test.tsx`, real store, `storage.ts` replaced | After a change, the new score shows and the pending view never did |
| 14 | The list gains a row when a match is written from outside; a page showing no match does nothing | Same seam, `MatchList.test.tsx`; and for "does nothing", claim 7 | The new row is there and the row that had focus still has it |
| 15 | A route shows its page, and an unknown match id shows not found | Route test, `renderRoute` | One case each |
| 16 | A mid-match reopen with no connection shows the score and takes a point | Browser suite, `context.setOffline(true)` | The score after reopening; one more point after a tap |
| 17 | No component, route or loader reaches storage, the core or the key | Static: a lint rule (oxlint `no-restricted-imports`) for `src/components/` and `src/routes/`, run by `web-client:lint` | Nothing runs |

### Later (sync and the stream)

| # | Claim | Seam | The test asserts |
|---|---|---|---|
| 18 | The cursor is never ahead of the records | Browser suite, storage harness | After `storePulled` is made to fail, the cursor is the old one |
| 19 | A cycle sends held records in journal order, scores last, and marks each by its answer | Service: `src/sync.test.ts`, MSW for the api, `storage.ts` replaced | The body the api received; the answers passed to `markAnswered` |
| 20 | A damaged parcel stores nothing and leaves the cursor; a record that doesn't verify is skipped and the cursor moves | Same, with the real core | What `storePulled` was given |
| 21 | With no connection a cycle changes nothing and tries again when it returns; cycles run on the triggers of section 6 | Same, fake timers, as `new-version.test.ts` | No write; a request after `online` |
| 22 | Only one tab runs a cycle at a time | **Needs a real browser and two tabs**, with the api held back | One request while both tabs ask |
| 23 | The client and the api agree on the two endpoints' shapes | Static: `web-client:api-types-check` and `web-client:typecheck` | Nothing runs |
| 24 | Intake stores a valid record once, stores one whose match is unknown, and stores nothing for a bad signature | Service, api: `api/tests/services/`, real PostgreSQL | The rows after |
| 25 | The feed gives a player's records after a cursor in order, and a score that arrived before its match is not lost | Same | Store score, then match; pull from a cursor between them |
| 26 | Each endpoint's outcomes map to their status and document | `api/tests/http/`, one case per outcome | Status and the OpenAPI check |
| 27 | A point scored on one device shows on another | Assembled stack, the one test for this journey: `e2e/`, two browser contexts | Device A scores; device B's details page shows it |
| 28 | The event stream passes the Worker | Assembled stack (hosting counts as wiring) | An event arrives at the page within seconds of a record being stored |

Not proven by any test: how the pages look (by eye; screenshots are for `/design-system/*` only), that scroll position survives a replace (claim 12 proves focus; scroll by eye), and tap-to-paint time on a real phone.

## 11. The user's answers (2026-11-14)

| # | Question | Answer | What the plan does |
|---|---|---|---|
| 1 | Is sync part of this epic? | "let's do a to h first" | Task 0 and A to H now. I to O are later and not to be built |
| 2 | What do a match's terms and a score hold, and how is the opponent named? | "something like that, but let's move the user stuff to zustand first" | Task 0 comes first. The working assumption below, to be confirmed in task A's pull request, since a layout is permanent once released (nothing is released yet) |
| 3 | Which score shows when two devices score the same game at once? | "let's not worry about this yet" | **Not decided. Don't build.** The placeholder of section 5 only. No `contested` state, no "score changed, tap again" rule. Needed before task L |
| 4 | Who may pull a player's records? | "let's not worry about this yet" | **Not decided. Don't build.** Nothing in 0 to H needs it. Needed before task J |
| 5 | How fresh must a watched match be? | "15 seconds is fine" | A pull every 15 seconds while a match is on screen (section 6). The stream stays later |
| 6 | May a small connected component read the store? | "yes" | Section 4, with the line for `web-client/CLAUDE.md`, added in task 0 |
| | Stores | "I don't really need just 1 store either, user can be one, myMatches can be one, etc." | `user`, `myMatches`, `match`; `sync` later (section 2) |
| | "we'd do writes through zustand interfaces too, right?" | Yes | Stated once, at the top of section 2 |

**The working assumption for answer 2.**

- **Terms:** a layout version, best of how many games, and points per game. Nothing else: terms hold only what the players agree to (design section 4).
- **Score value:** a layout version and two counts, the points of each side in one game, absolute. Slot n is game n; slot 0 (the whole match) is not written by these tasks.
- **The opponent:** a `player` record this device makes, which creates "an extra player managed by the signer's account". The design says such a record counts only once the account is approved; on one device nothing judges that, and it is settled with identity. `createMatch` writes it and the `match` record in one commit.

## 12. Where this departs from the earlier documents

- **`PLAN-offline-scoring.md` section 5** replaces a temporary score by comparing a `baseRev` with the server's revision. This plan uses the design's rule (an entry names what it replaces), since the design says it wins and the rule needs no server.
- **Design section 14** puts "which records to send next, how to apply a server reply" in the core. Here they are a few lines of TypeScript in `sync.ts` and `storage.ts` (journal order, scores last; a state per answer). There is one client today. They move into the core when a second platform needs them, behind the same functions.
- **Design section 5** says records pulled from the server go through the same intake as a scanned code and become held. Here a pulled record is stored as acknowledged at once: the server sent it, so it holds it. A scanned record (later) is held.
- **Design section 5.4** lets another tab take over a sync lock from a suspended tab after a timeout. Not built: requests time out, so a cycle is short, and an overlap would be harmless anyway (L3).
- **Design section 7's pulled view** (outcome states, tags, identity state, the stamp) is not in the first pull. Matches and scores need none of it.
- **Design D3** says a guest account cannot manage other players, and a `player` record counts only for an approved account. The working assumption names the opponent with one anyway, on the device only (answer 2).
- **The brief's "a pull, and a push if needed".** The design makes them one cycle, send first. This plan keeps that.
- **The stores are a second cache.** The design's views are caches computed from the journal. A zustand store is a copy of a view, in memory, for mounted pages only. It holds nothing that can't be dropped at any moment.

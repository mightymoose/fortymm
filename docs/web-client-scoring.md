# web-client scoring

The scoring pages, the URL fragment, board sync and the result pages.

- `matches/$matchId/scores/game/$gameNumber/edit.tsx`: the page
  `ScoreGame` (`src/pages/scoring/`), a match's scores, with the
  wordmark, a link to Home and no `AppShell`. It edits one game. Each
  scoring route's loader finds the match with `scoringMatch()`
  (`src/scoring/matches.ts`), or the edit route's with `carriedMatch()`,
  which gives null rather than throwing, and the pages read it with
  `matchOf()`.
  `demo` and `demo-spectator` come from `demoMatch()`
  (`src/scoring/demoMatches.ts`). `demo` is a best of 5 between the
  session's player and `brave badger 214`. In `demo-spectator`, two
  other players play, so the viewer is a spectator. Any other id is a
  match the API made, with nobody standing in. Its fragment holds its
  uuid, best of, rated and players, because `draftHash()` keeps a draft
  with no games for it (`Match.source` is `api`). A demo match's draft
  with no games is still the empty fragment. So the loader reads the
  match from the fragment and sends no request, which works offline.
  The page reads no match from the API, so it has no player's name. A
  player sees You and Your opponent, and a spectator sees `Player 1` and
  `Player 2`. For an id that isn't a demo match, a fragment that is
  empty, can't be read or names another match throws `notFound()` on the
  submission and approval routes. The edit route rebuilds it instead (see
  below). Only an API match syncs its board,
  and only for an account with `matches.score`, as the API refuses
  anyone else's (`syncsBoard()` in `src/scoring/matches.ts`). A demo
  match, or an account without it, sends nothing and shows no sync mark.
  One pad holds a big score input per player and the games tally
  between them, the viewer's player on the left, then the actions
  (`ScoreEntry.tsx`). To a player, the page names the players You and
  Your opponent, with no avatar, as in "You win 3–1" (`playerLabel()` in
  `sides.ts`). A spectator sees their names. The left score has focus
  when a game opens. Enter moves to the other score while it is empty,
  and otherwise submits the pad's form. A strip (`GameStrip.tsx`) shows
  each game, with its score in mono and the game winner's points bold.
  It links to each game that can open, keeping the URL's fragment. Games
  after the decider step back, under "Match decided after game N", and
  stay editable. Below 880px the two sides stay side by side and the
  buttons split the width, with Save or Submit on the right.
- The URL's fragment holds the match's scores, as base64url
  (`src/scoring/fragment.ts`). It is empty, a bare payload of
  `encodePayload()` (a draft nobody approved yet), or a COSE_Sign
  envelope, the same bytes a result link carries. The URL is the
  scorer's truth, so a reload shows the same games and any scoring URL
  can be shared. The games are an ordered list with no gaps. Game N opens
  only once game N-1 has a score.
- Each scoring route's loader reads the fragment once with
  `readFragment()`, and the page trusts the loader's data. The CBOR codec
  decodes the bytes, and `fragmentResultSchema()`, a zod schema built per
  match, checks the result. It must name the match's `uuid`, `bestOf` and
  `rated`, end `completed`, and hold at most `bestOf` games, each a legal
  score (`checkGame()`). A save changes only the hash, which keeps the
  same route match. So the routes set `shouldReload: true` and a
  `blocking` loader, and the loader runs again before the page renders.
- The edit route rebuilds a fragment that gives no scores for an API
  match: empty, unreadable, for another match, or holding scores the
  match can't. Online (`navigator.onLine`), its loader loads the match
  with `matchQuery()`, with no retry, and redirects with a replace to
  where Keep score on the match's page goes (`keepScoreTarget()`, see
  `docs/web-client-pages.md`): the first game with no score, with the
  API's finished games and, for a pending result, its `result_hash` in
  `replaces`. A final match goes to its page instead, as editing after
  final is #316's. No match is `notFound()`. While it loads, the route's
  `pendingComponent` (`ScoresLoading`) shows the score page's frame with
  a skeleton, and an error answer shows the boundary's alert with Try
  again (`ScoresFailed`), which runs the loader again. A fragment that
  gives scores never asks the API, so a restored tab works offline.
- With no network (`navigator.onLine` false, or the request got no
  response), and for a demo match always, the edit route drops a
  fragment it can't read. It redirects to game 1 with no scores, with a
  replace. An API match's fragment keeps its details, and a demo match's
  is empty, so a reload or a share doesn't carry it, and sets
  `discardedScores` in the router's history state (typed in
  `src/router.tsx`). The page then says "This link’s scores couldn’t be
  read, so the scores start empty." A fragment with no details of the
  match leaves nothing to start from, so the loader gives `unreachable`
  and the page (`ScoresUnreachable`) says "This match’s scores aren’t on
  this device" and to open the match once with signal, with a link to its
  page. A game number past the first game
  with no score, or one that isn't a whole number, goes to that game,
  with a replace, keeping the hash.
- `matchFor()` in `demoMatches.ts` is the demo match a result names, as
  this device knows it. Each device builds
  `demo` as its own player against `brave badger 214`. So a result from
  another device names that device's player and the badger. The viewer
  stands in for the badger, unless the result already names the viewer.
  The points stay in the result's order, and the viewer's side goes on
  the left. A player this device can't name shows as `Player 1` or
  `Player 2`. Nobody stands in for a player of `demo-spectator`. The page
  works out a demo match's players from the session on each render, not
  in the loader, because a saved account can stand in for the session until
  the API answers with another player.
- Anyone who can open the match can save any game that can open. The
  only check is that the game's score is legal (`parseGameScore()` in
  `src/scoring/board.ts`). The match rules apply only at submit.
  `reviewBoard()` reads the games in one pass and gives `decided`,
  `undecided` or `overrun` (games after the decider), with the decider's
  game number. `planPress()` (`src/scoring/planPress.ts`) decides what
  the pad's button does, from the games, the viewer, the game and what
  is typed: `disabled`, `save` with the game to open next, or `submit`.
  Save goes to the next empty game, unless the match is decided.
- A save puts a new draft in the hash, on this device, and the page
  moves on at once. It pushes when the game number changes and replaces
  when it stays. Nothing about saving waits on the network. Clear game
  shows only on the last game with a score, and removes it.
- When the board syncs, each save and each submit also sends it in the
  background (`src/scoring/sync.ts`), so spectators and tournament
  directors can watch the match. `pushBoard()` (`src/scoring/boardApi.ts`)
  sends it to `POST /v1/matches/{match_id}/boards` as the hex of the
  fragment's bytes, with `keepalive`, and gives up with no response after
  10 seconds, which counts as offline. Sync is best effort. It never holds up
  or fails a save. The board is a snapshot, the fragment's text, with no
  outbox of changes. `src/scoring/boards.ts` keeps, per match and in memory only,
  the newest board this tab saved that the server hasn't taken
  (`pending`), and the last one the server took from this tab
  (`synced`), and why the server last refused one (`refused`). A newer
  save replaces an unsent one, and a reload forgets it. Each match
  sends one board at a time, so a late older copy from this tab can't
  land after a newer one. Across tabs and devices the
  last write wins. The scoring page only sends. It never reads the
  server's board back, so another device's board never changes this
  tab's pad.
- A match's sync is a state machine of `idle`, `sending`,
  `waitingRetry`, `waitingOnline` and `stopped`, with why the last send
  got stuck kept beside it. `nextStep()` picks what an idle sync does.
  While the browser knows it's offline (`navigator.onLine` is false),
  it sends nothing until it wakes. A board that can't get through
  waits, with a backoff of 2, 4, 8, 15 and then 30 seconds, or until
  it wakes. The sync wakes when the browser fires `online`, or the
  page fires `pageshow` or turns visible, as iOS Safari can resume a
  page without `online`. A 429 waits out its `Retry-After` instead, if
  that is longer than the backoff, but never more than 5 minutes, and
  nothing wakes it early. A 401 means the session lapsed. It refreshes
  the session through the callback `Root` gives `useAppSync()`, keeps
  the board and waits the backoff, so the board goes once the session
  is back. The callback refetches the session even when no page reads
  it, such as `/design-system`. Each 401 refreshes again, and a refresh while a session
  request is still on its way joins it (`sessionQuery()`), so two never
  go at once and start a second guest account. Any other 4xx is a refusal. It drops the board, which is never sent
  again and never shows as synced, and keeps why in `refused` until a
  later board lands, even after the sync stops, and even when the
  account may no longer sync, as after a 403. A 409 reads as a final
  match. Any other refusal is logged with `console.warn`, and a 403
  also refreshes the session through the callback `Root` gives
  `useAppSync()`, in case a permission was taken away. `useAppSync()` runs in `Root`, on every
  page, for each match with a board to send, so it still goes after the
  person leaves the scoring page. A sync stops when its last holder lets
  go, and a response that lands after that changes nothing.
- A submitted result goes through the same sync, after the match's
  board, to `POST /v1/matches/{match_id}/approvals`, through
  `pushResult()`, which records it with the submitter's signature.
  `src/scoring/results.ts` is the outbox: per match, every envelope this
  device submitted that the API hasn't taken, oldest first, the same one
  once. Unlike a board, every result goes, in order, because each
  replaces the one before, so a first result and its correction
  submitted offline both land, first first. The outbox lives in
  `localStorage`, read afresh and written under a Web Lock on each
  change, so two tabs' changes take turns, and a reload keeps it and
  `useAppSync()` sends it from any page that has loaded the session.
  Without one, as on a public page or `/signed-out`, results wait, since
  a 401's session refresh would start a guest account there. If a write to it fails, the
  outbox stays in the tab's memory from then on. A result waits and
  retries as a board does. Three refusals can mean "not yet": 409 stale,
  when the result it replaces is still on another phone, 422 for an
  unknown key, when this device's key hasn't registered yet, which also
  refreshes the session so the key registers, and 403, as the next
  session may hold `matches.score`. The API's errors carry no code, so
  the first two are told by their titles (`src/api/errors.ts`). After
  any of them, the result keeps trying, with the backoff and then every
  5 minutes or when the page wakes, until a day after it was signed
  (`notYet()`). A link's signing time isn't checked against its
  signature on the device, so one more than an hour ahead of the
  device's clock counts as a refusal for good. Results go in passes: a pass sends
  every queued result once, oldest first, skipping only those that came
  back stale earlier in the same pass, as a later one may be the result
  an earlier one replaces. The sync waits only once a whole pass came
  back stale. A result settling, and every wait, starts a fresh pass, so
  a result that the other phone has since unblocked gets its turn. Such
  a wait doesn't make the strip say the sync is stuck, and a board or a
  result saved meanwhile ends it. The API
  taking it, or refusing it for good (any other 4xx, logged with
  `console.warn`), removes it, and the next one goes. A
  result refused for good changes nothing on the strip. Approve result
  queues the link's envelope, then the envelope with both signatures,
  for an account whose board would sync. Opening a link queues nothing,
  or a link could commit scores with the viewer's session before they
  reviewed them. So a device sends only results it submitted or
  approved, each before anything built on it, and a counter made from a
  result that hasn't reached the API yet still lands after it.
- The strip shows each game's sync while this tab has a board to send.
  A game is unsynced when its points differ from the `synced` board. It
  shows a dot while the board is on its way, a dashed grey edge and a
  lighter label while its sync is stuck, and green for 1.2 seconds
  once it lands. A game goes green only when `landed`, the count of
  boards the server took, went up, so a refused board's games just go
  plain. Screen readers hear `Syncing`, `Not synced` or `Synced`. A
  sync is stuck, and the strip's header line says why, in two cases.
  `Offline. Saved on this device.` shows while the browser knows it's
  offline, and from the first send that got no response
  (`ApiUnreachable`). `Not synced yet. Saved on this device.` shows from
  the second failed send in a row that got a response, such as a 5xx,
  and from the first 429, as its wait can last minutes. A 502 to 504
  from Cloudflare is a failing server, not an offline device. Any other
  one failed send with a response changes nothing while it waits to
  retry, so a blip doesn't flash a warning. A refusal
  ends the run of failures. Otherwise,
  after a refusal, it says `Match final. A correction syncs once you submit it.` for
  a 409 and `Not synced. Saved on this device.` for
  any other.
  The marks never change a cell's size, and the line keeps its height.
- When a player's press would leave a `decided` board, the button reads
  Submit result, and the line beside it says who wins. Submit drops any
  signatures, signs the games with the typed score with this browser's
  key (`signResult()`, for the viewer's side), puts the envelope in the
  pad's URL too, so the phone's Back button opens a pad that corrects
  it, and goes to the submission page with the envelope as its hash. When the board syncs,
  it also queues the envelope for the API (see the results outbox above),
  so the server holds the submitter's signed result. A correction can then
  replace it, a result it replaced can't be approved, and an unrated match
  is final as soon as it lands. With no key, it says
  under the button that the browser can't sign yet. On an `overrun`
  board, the strip tells a player which games to clear. A spectator's
  button only saves, and the page says who submits instead
  (`ResultPanel.tsx`).
- A draft or envelope made from a signed result names it in `replaces`,
  the SHA-256 of its payload, from the first save on. A draft keeps the
  `replaces` it has. `replacesOf()` hashes in the save or submit
  handler, never at render. Above the pad, a signed fragment shows
  "Reported by your opponent. A change makes a new result that corrects
  it.", or "Approved by both players." and the same sentence once both
  sides signed. A draft with `replaces` shows "This corrects an earlier
  result." The page never says "sign".
- `matches/$matchId/scores/submission.tsx`: the page `AwaitingValidation`
  (`src/pages/matches/`), where a submitted result lands, with the score
  page's frame. Its hash is the signed envelope, and its loader gives
  the page nothing else to read. A fragment that isn't a signed result
  of the match shows "This page has no result to share". The side that
  signed last is the submitter's. It says which player must confirm, and
  shows the games and the winner. Then it shows the approval link as a
  QR code (`QrCode` in `src/components/`, at level L) and as a link, and
  says to scan the code with a phone's camera, which opens the approval
  page. The link is same-origin
  `/matches/<matchId>/scores/approvals/new#` and the envelope in
  base64url, so it opens in dev and on a Preview. It isn't the format's
  `https://fortymm.com/r#` link, and the app has no `/r` page. The QR
  doesn't hold the format's `FMR1:` text, which no phone camera opens.
  At level L the longest result's link from a Preview keeps each module
  at 3px or more in the 320px code, so a phone camera reads it. Copy link
  copies it. "Back to the scores" opens game 1 with the same envelope.
  A demo match has a fixed `uuid` for the result, and is unrated.
- `matches/$matchId/scores/approvals/new.tsx`: the page `AcceptResult`
  (`src/pages/matches/`), which the link opens, with the score page's
  frame. It works offline, and its loader sends no request. The loader
  takes only a signed result that the match's scores could hold, by the
  same zod check, so a retirement or another best of shows "This link
  isn’t a FortyMM result" too. Until matches come from the API, every
  viewer stands in as the player whose side hasn't signed, or once both
  have, the side that signed last. "Review match score" heads it, then
  the outcome for the viewer, such as "Your opponent reported that you
  lost 3–1. Do these scores look right?" One `.fm-games` table follows:
  a row for You, then one for Your opponent, each game's points, then
  Won. A row shows the session's own username beside its role. Nothing
  fetches another one. Below 880px the username drops under the role, so
  a best of 7 fits a phone. Under the table are best of, rated, when the
  opponent reported it and whether it corrects another. The page never
  says "sign". Approve result appends this browser's signature
  (`appendSignature()`) and replaces the URL's fragment with the new
  envelope, so the page says "Approved on this device" from the link
  alone, after a reload too. The approval never waits on the network.
  Then `ServerCheck` sends the envelope to `POST
  /v1/matches/{match_id}/approvals`, with the payload's match id, through
  `approvalCheckQuery()`, in its own `QueryBoundary`. Online, it first
  waits up to 10 seconds for this device's results queued before it to
  land (`afterEarlierResults()`), as the API would find it stale before
  them. A refusal that the outbox counts as "not yet" (`notYet()`), for an
  envelope the outbox still holds, shows "FortyMM can’t take it yet, so
  this device keeps sending it" rather than a refusal, and checks again
  once the outbox has sent it. Its verdict is
  `accepted`, or `refused` with the API's title for a 404, a 409 or a
  422. Accepted says
  "FortyMM checked the signatures and the scores". Refused shows "FortyMM
  refused this result" with the title. No network shows the boundary's
  error with Try again, under "Approved on this device". The query is
  keyed by the envelope, so a reload sends it again, which the API
  answers as a retry. The API never makes a demo match, so a demo
  approval gets its 404, "No match has this id", as a refusal. Edit scores opens the match's game 1
  with the page's fragment, unchanged. After an approval, that is the envelope
  with both signatures. It checks no signature. With no key, it says the
  browser can't sign yet.

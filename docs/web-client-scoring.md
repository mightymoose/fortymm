# web-client scoring

The scoring pages, the URL fragment, board sync and the result pages.

- `matches/$matchId/scores/game/$gameNumber/edit.tsx`: the page
  `ScoreGame` (`src/pages/scoring/`), a match's scores, with the
  wordmark, a link to Home and no `AppShell`. It edits one game. Each
  scoring route's loader finds the match with `scoringMatch()`
  (`src/scoring/matches.ts`), and the pages read it with `matchOf()`.
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
  empty, can't be read or names another match throws `notFound()`. So
  the edit route's redirect after an unreadable fragment of the match
  ends on the not-found page too. Board sync still goes to the demo
  server for every match.
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
- The edit route drops a fragment it can't read. It redirects to game 1
  with no scores, with a replace. An API match's fragment keeps its
  details, and a demo match's is empty, so a reload or a share doesn't carry it,
  and sets `discardedScores` in the router's history state (typed in
  `src/router.tsx`). The page then says "This link’s scores couldn’t be
  read, so the scores start empty." A game number past the first game
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
- Each save, and each submit, also syncs the board in the background
  (`src/scoring/sync.ts`), so spectators and tournament directors can
  watch the match. Sync is best effort. It never holds up or fails a
  save. The board is a snapshot, the fragment's text, with no outbox of
  changes. `src/scoring/boards.ts` keeps, per match and in memory only,
  the newest board this tab saved that the server hasn't taken
  (`pending`), and the last one the server took or this tab pulled
  (`synced`). A newer save replaces an unsent one, and a reload forgets
  it. Each match sends one board at a time, so a late older copy from
  this tab can't land after a newer one. Across tabs and devices the
  last write wins.
- A match's sync is a state machine of `idle`, `sending`,
  `waitingRetry`, `waitingOnline`, `pulling` and `stopped`, with why the
  last send got stuck kept beside it. `nextStep()` picks what an idle
  sync does. While the browser knows it's offline (`navigator.onLine`,
  or the demo's `offline`), it sends nothing and waits for `online`. A
  board that can't get through waits, with a backoff of 2, 4, 8, 15 and
  then 30 seconds, and goes as soon as the browser fires `online`. A 4xx
  other than 429 drops the board. `useAppSync()` runs in `Root`, on every
  page, for each match with a board to send, so it still goes after the
  person leaves the scoring page. A sync stops when its last holder lets
  go, and a response that lands after that changes nothing.
- Only the scoring edit page pulls the server's board, and only while
  this tab has nothing to send. It pulls when the page opens, after each
  board the server takes, and every 5 seconds while the page is visible.
  A pulled board that `readFragment()` can't read, or that doesn't fit
  the match, is ignored. `adopts()` decides whether the page takes it,
  with a replace, on the same game or the last one that can open. The
  page follows the server while its fragment is empty or is the board it
  last synced. So two tabs on one match converge while idle. A board
  from a link, such as one that Edit scores opens, gives way only to a
  board issued later, so opening it never undoes it.
- `src/scoring/demoServer.ts` stands in for the API's match routes. It
  keeps the latest board per match under `fortymm-demo-server:<matchId>`,
  with `putBoard()` and `fetchBoard()`. Each call waits, then may fail,
  as the demo network says: `normal` (300ms), `slow` (2.5s), `flaky`
  (every second request on that network answers 503), `offline` (each
  request fails at once) or `broken` (500). The network is in
  `localStorage` under `fortymm-demo-network`, and each request reads it.
  A switch to any network but `offline` fires `online`, as a connection
  that came back does. Tests set it with `setDemoNetwork()`.
- A Testing panel at the bottom of the edit page (`TestingPanel.tsx`)
  switches the network. Reset match clears the server's board and this
  tab's unsent one, and opens game 1 with no scores. An API match keeps
  its details in the fragment. Clear everything does
  that for every demo match and sets the network back to `normal`. Both
  drop the demo server's requests in flight, so a late one can't bring
  back what they cleared. The panel goes when the API has matches.
- The strip shows each game's sync while this tab has a board to send.
  A game is unsynced when its points differ from the `synced` board. It
  shows a dot while the board is on its way, a dashed amber edge and
  label after a send that didn't get through, and green for 1.2 seconds
  once it lands. Screen readers hear `Syncing`, `Not synced` or
  `Synced`. The strip's header line says when the device is offline.
  The marks never change a cell's size, and the line keeps its height.
- When a player's press would leave a `decided` board, the button reads
  Submit result, and the line beside it says who wins. Submit drops any
  signatures, signs the games with the typed score with this browser's
  key (`signResult()`, for the viewer's side), and goes to the
  submission page with the envelope as its hash. With no key, it says
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
  shows the games and the winner. Then it shows the signed result as a
  QR code (`QrCode` in `src/components/`, the `FMR1:` text at level M)
  and as a link. The link is same-origin
  `/matches/<matchId>/scores/approvals/new#` and the envelope in
  base64url, so it opens in dev and on a Preview. It isn't the format's
  `https://fortymm.com/r#` link, and the app has no `/r` page. Copy link
  copies it. "Back to the scores" opens game 1 with the same envelope.
  A demo match has a fixed `uuid` for the result, and is unrated.
- `matches/$matchId/scores/approvals/new.tsx`: the page `AcceptResult`
  (`src/pages/matches/`), which the link opens, with the score page's
  frame. It works offline and makes no request of its own. Its loader
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
  `approvalCheckQuery()`, in its own `QueryBoundary`. Its verdict is
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

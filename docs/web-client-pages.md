# web-client pages

What each page outside scoring does. `web-client/CLAUDE.md` holds the routing conventions.

- `__root.tsx`: the root route, with component `Root` (`src/pages/Root.tsx`),
  and the router context type (`api`, `queryClient` and `appUpdate`). `Root`
  gives every page toasts, tooltips and the update notice (see Service
  worker), and no frame.
- `_authenticated.tsx`: a pathless layout route with no path segment and no
  component. Pages that will need a signed-in user go in `_authenticated/`.
  Its loader starts the session, and its `pendingComponent` is the loading
  screen (see API client).
- `_authenticated/_shell.tsx`: a pathless layout route under
  `_authenticated`, with component `ShellLayout`
  (`src/pages/ShellLayout.tsx`). Its pages, such as `/`
  (`_authenticated/_shell/index.tsx`), go in `_authenticated/_shell/`. A
  page that stands alone, such as `/review-players`, goes directly in
  `_authenticated/`. The layout puts the page in `AppShell`
  (`src/pages/AppShell.tsx`): a topbar over a sidebar of
  the `_shell` pages, which folds to its icons and remembers it in
  `localStorage`. Below 900px the sidebar is a tab bar along the bottom. To
  add a page to the sidebar, add its `NavLink` in `AppShell`. It lists Home,
  then Matches for an account with `matches.view` and Players for one with
  `players.view`. Below 900px (`useNarrowLayout()`, `src/pages/`) the tab
  bar ends with New match for an account with `matches.create`. Each link
  is open only on its own page, so Matches isn't open on New match. The
  links read the session without suspending, like the account menu. The topbar's right
  end shows `UserMenu` (`src/pages/userMenu/UserMenu.tsx`): a chip of the
  player's `PlayerAvatar` (`src/components/PlayerAvatar.tsx`, the initials
  of the display name, whose accessible name is the full name) and the
  name. Below 600px the chip hides the name. The chip opens the account
  menu. An account with `admin.view` gets an Administration link there. Below 900px
  (`useNarrowLayout()`), the menu also links to each mobile beta in
  `mobileApps` (`src/mobileApps.ts`), in a new tab. A verified account gets
  Sign out, which signs out at once. A guest
  gets Sign in, and Sign out behind a dialog. The dialog says nobody can
  get a guest account back after it signs out, and links to sign-in. The
  menu reads the session without suspending, so it never holds up the
  loading screen.
- `SignInErrorAlert` (`src/pages/SignInErrorAlert.tsx`) sits in
  `ShellLayout`, inside `AppShell` and above the page, and on
  `/signed-out`. If the URL
  has `sign_in_error`, it shows that code's message from `signInErrors`
  (`src/pages/signInErrors.ts`). An unknown code shows the `failed`
  message. `rate_limited` also shows `RetryTime`, `retry_after` seconds
  after the page loaded, if the URL has a positive number there. It keeps
  the message in state and removes `sign_in_error` and `retry_after` with a
  history replace, so a reload shows nothing. `cancelled` and `used` are
  neutral `fm-alert`s with `role="status"`. The other codes are `fm-alert--error`
  with `role="alert"`. Its link starts another sign-in, back to the page,
  or to its `returnTo` prop. It reads Try again, or Sign in for `used`,
  where nothing failed.
- Home (`src/pages/Home.tsx`) shows a New match link to `/matches/new` for an
  account with `matches.create`, above the roadmap. Below 900px the link
  is in the tab bar instead. The sidebar doesn't list it.
- `_shell/matches/index.tsx` and `_shell/players/index.tsx`: the pages
  `Matches` (`src/pages/matches/Matches.tsx`) and `Players`
  (`src/pages/players/Players.tsx`). Players so far shows only its title.
  Each loader waits for the session, and sends an account without
  `matches.view` or `players.view` to `/`.
- Matches lists the 50 newest matches, everyone's, from
  `GET /v1/matches`. When more exist it says "Showing the 50 newest
  matches." under the list, and the filters act on those 50. Filter
  chips narrow it: the state chips (Live, Waiting for sign-off, Final)
  widen each other, and Your matches narrows to the viewer's. A match
  nobody has scored shows as Not started and counts under Live. From
  900px it's a table whose game scores wrap, so it fits beside the
  sidebar. Below 900px each match is a design system match row, with
  only the names until someone scores. With no match at all it says
  "No matches yet", with a New match link for an account with
  `matches.create`. When the chips leave none, it says to turn one off.
  It never shows an empty table.
- Each match links to `_shell/matches/$matchId.tsx`, its page
  (`browse/SignOff.tsx`), from `GET /v1/matches/{match_id}`: the games,
  who retired if anyone did, each player's signature, what the viewer can
  do about the result (a spectator only sees where it stands), and the
  history. A final result says both players approved it, that one player
  reported it (an unrated result the other side never approved), or that
  an administrator set it, with their reason. The history's lines come
  from the API's events (`eventText()` in `browse/match.ts`). A signature
  that replaces the other side's pending one reads "Signed different
  scores". An id that isn't a uuid, or one the API answers 404 to, shows
  "No such match". The first sends no request.
- `matchesQuery()` and `matchQuery()` (`src/api/queries.ts`) turn the
  API's matches into `MatchRecord` and `MatchDetail` (`browse/match.ts`).
  The API works out each match's state, and the page only words it. Each
  loader prefetches its query without waiting for it, so a link's preload
  (hover, focus or touch) loads the data, and the page's own boundary
  shows the skeleton.
  `matchQuery()` refetches every 10 seconds while the match isn't final
  and the tab is visible. The page says when it last read the match
  ("Updated 19:32"). A failed refetch keeps the last score and its time.
- `_shell/matches/new.tsx`: the page `NewMatch`
  (`src/pages/matches/NewMatch.tsx`, with its parts in `newMatch/`),
  which sets up a match. Its loader waits for the session, and sends an
  account without `matches.create` to `/`. Then it starts
  `opponentsQuery(api, '')` without waiting, so the page shows at once
  and a failed request fails only the list. The card holds the session's
  player, the opponent, the match length (1, 3, 5 or 7, a radiogroup
  with one tab stop, 5 to start), Rated match and a summary with Cancel
  and Start match. The opponent comes from the recent opponents, each in
  its own `QueryBoundary`, or from Search all players. The search asks
  `GET /v1/matches/opponents?search=` 200ms after the last key, and keeps
  the last players up while the next ones load (`useDeferredValue`).
  Back to recent opponents leaves it. A picked opponent shows with
  Change. One reducer holds the form (`newMatch/setup.ts`): the opponent
  as `none` or `picked`, the best of, rated, the last attempt and the
  submit state. Rated is off and can't turn on without an opponent, and
  Change turns it off. Start match is never off. Without an opponent it
  says "Pick an opponent to start the match." and sends nothing. Each
  press sends `POST /v1/matches` with a UUIDv7 (`uuidv7()` in
  `src/api/uuidv7.ts`). A press with the same details as the last one
  sends its id again, so a retry after a lost response finds the match
  the first press made. Then the page opens game 1 of the match's
  scores, with a draft of no games as the fragment, so the scores open
  with no network. Nothing caches the match. A 422 shows the API's
  title and loads the opponents again, since a player may have merged.
  A create that answers after the person left the page opens nothing. While `navigator.onLine` is false, Start match sends
  nothing, and a request that gets no response is the same. Both say
  "Making a match needs a connection. Connect, then press Start match
  again." The form keeps its state, and the next press sends the same id.
  Another failure shows its `failureMessages`, and Start match stays
  pressable. The page has no guard against leaving it.
- The sign-in links come from `useSignInHref()`
  (`src/pages/useSignInHref.ts`). Each is a full page load of
  `/api/v1/auth/login` with the current path and query as `return_to`,
  because the API answers with a 302.
- `AfterSignIn` (`src/pages/adoption/`): Home shows it only when the URL
  has `signed_in=1`. For a verified account, it reads
  `GET /v1/account/players` in its own `QueryBoundary`, with no skeleton
  and the inline error (see API client). It replaces the URL with
  `/review-players` when a question is open, or with `/` without the param
  when none is. So a reload doesn't open the review again. A guest asks
  for no players and keeps the param, because after a slow sign-in the
  session shows the saved guest account until the verified one comes.
- `review-players.tsx`: the page `PlayerReview`
  (`src/pages/adoption/PlayerReview.tsx`), with the wordmark and no
  `AppShell`. The wordmark always shows. The question and its answers read
  `GET /v1/account/players` in a `QueryBoundary`, with a skeleton of the
  question and the action bar, and an error that also links to Home. A
  guest goes to `/` before it asks for players. It asks "Is this you?"
  about one open question at a time. The account's `self` player with an
  open question comes last, and stays last once it becomes `managed`.
  While its question is open, a "Yes" to another player makes that one
  the account's own and merges nothing. Under the question, a match preview
  (`MatchPreview.tsx`) sums up the player's matches, as in "3 matches
  today, last one against Sam", or says "No matches yet". It lists each of
  `recent_matches` with its opponents, "Won 3–1", "Lost 1–3" or "No
  result", and the day and time, then how many earlier matches it leaves
  out. A match with no opponents names "another player".
  "Yes, this is me" answers `yes`. A player whose `played_against` names
  the account's `self` player gets no "Yes, this is me", and the page says
  that it played that player. While the `self` player's question is
  open, "Yes" on another player says "<player> becomes your player. We'll
  ask about <own player> next." instead, or "last" while more than one other
  question waits. When the question is about the
  `self` player itself, the page says it stays your player. "Someone else
  played" asks "Do you
  manage this player?". There "Remove from my account" answers `not_mine`,
  and Back goes back. "I manage this player" answers `no`, unless the
  account manages another player with a closed question. Then it asks
  "Which player?", with one button per such player that isn't in its
  `played_against`, which answers `same_as`. Its "Keep as a separate player" answers `no`, and its Back
  goes back. The question has no way out but an answer. A reducer holds the page's
  state: every player it has queued this visit, the last confirmation,
  and the step and failed answer of the player on screen. The counter
  "Player N of M" counts the queued players, so it holds when another tab
  answers one, and grows when a new one comes. A ref holds the answer in
  flight, so a second quick click sends nothing. An answer button also
  ignores a click whose `detail` is above 1. That is the second click of a
  double click, which can land on the next player's button. A keyboard
  press has `detail` 0. "Yes" says it merges the player into the other `self`
  player of the players list, once that one's question is closed. An answer first cancels a players request
  in flight, because that request read the list from before the answer.
  An answer puts the API's list in the players query, and the list's
  `self` player in the session's account, so the topbar and New match show
  it with no session request. Every answer does, `already_answered` too,
  and so does every fetch of the players, such as the refetch after
  another tab answered first. It also saves the account, so an offline
  load shows that player. The
  confirmation comes from `meta`, such as "brave badger 214 merged into
  excited egret 387, your player." A merge into a `managed` player drops
  ", your player". The merged player can be the reviewed one or the other
  one. The merged player has left the list after the answer, so its name
  comes from the list before it. `already_answered` says "<player> was
  already answered in another tab." While players remain, the
  confirmation shows above the answers. After the last one, the page goes
  to `/` and shows it as a toast. A save that fails shows its error under
  its button. A 409 to `not_mine` means that another tab answered the
  player first, so the page says so too, and refetches the players. A 409
  to `yes` or `same_as` means that another tab's answer made it a merge of
  two players who played each other. The refetched players drop that
  answer's button, so the page shows the API's title as its notice. A 404 can mean that
  another tab merged the player. Then the page refetches the players, and
  says so only if the player left the list. A 404 to `same_as` can also
  mean that another tab merged the chosen player away. Then "Which player?"
  says that the player isn't one of the account's players any more. With no
  open question, or for a guest, the page goes to `/` at once. For a verified account, each time the page goes to `/`, it sets
  `fromReview` in the router's history state (typed in `src/router.tsx`).
  That covers the last answer and a visit with no open question. Home then
  focuses its title, so focus doesn't fall to the document.
- `_shell/admin/`: the admin pages (`src/pages/admin/`), for an account
  with `admin.view`. `route.tsx` has no component. Its loader reads the
  session and sends any other account to `/`.
- `_shell/admin/index.tsx`: the page `Admin`. It has a tab each for roles,
  permissions, accounts, players and signing keys. The `tab` search param names the
  open tab (`src/pages/admin/tabs.ts`), and a tab change replaces it.
  `Admin.tsx` keeps each tab's label and panel in a `Record` of the tab
  ids, so a tab without a panel fails `tsc`. `Tabs` is
  `lazy` there, so a tab loads its lists when it opens. Each tab's list has
  its own `QueryBoundary` with a table skeleton. `roles.manage` shows the
  controls that add, edit and delete roles and permissions. A built-in
  permission has no Delete. The default role shows a Default tag, and
  otherwise works like any other role. The
  accounts tab (`AccountsSection`) has a `SegmentedControl` of Verified,
  Guests and All, from its `VIEWS` record, which also holds each view's
  copy. Verified, the default, is by email. Guests and All put the account
  seen longest ago first. Its search finds an email or a player name, and
  stays when the view changes. Each row has the account (a verified one's
  email over its player, or a guest's player with a Guest tag, either
  linked to the account's page), its roles, matches, last visit and join
  date. It says when it shows only 50.
  The players tab (`PlayersSection`) does the same for players by name,
  each with the account that plays as it (linked, "Guest" or None) and how
  many accounts manage it.
  The signing keys tab (`SigningKeysSection`) lists every account's keys,
  searched by email or player name, each with its account (linked, or
  "Guest"), registration and state from the API's `state`. With
  `signing_keys.revoke`, a key that isn't revoked has Revoke…, which opens
  a `ConfirmDialog` that says what a revoke does. `ConfirmDialog` takes
  its busy label from the caller.
- `_shell/admin/accounts/$accountId.tsx`: the page `AccountAdmin`, one
  account's admin page. A breadcrumb links back to Administration and to
  `/admin?tab=accounts`. The account loads in its own `QueryBoundary`,
  from `GET /v1/admin/accounts/{account_id}`. A 404, or a 422 for an id
  that isn't a UUID, shows "No such account", as an adopted account does.
  It shows the account's email, or a guest's player with a Guest tag, its
  player, matches, join date and last visit, then a Roles card.
  `account_roles.manage` makes a verified account's card a form of every
  role's checkbox with Save roles. Otherwise the card lists the roles the
  account holds, and for a guest says they change once it signs in.
  Add the account's other admin tools to this page.
- `_shell/admin/players/$playerId.tsx`: the page `PlayerAdmin`, one
  player's admin page, built like an account's. Its breadcrumb goes to
  `/admin?tab=players`, and it loads from `GET
  /v1/admin/players/{player_id}`. A 404, or a 422 for an id that isn't a
  UUID, shows "No such player". It shows the player's name, when it was
  added, its matches and leagues, then an Accounts card that lists each
  account that plays as it or manages it, a verified one linked to its
  page, with a tag for an unanswered "Is this you?". A merged player's
  page links to the player it merged into. The page changes nothing yet.
- The admin forms use react-hook-form and zod. Each zod schema repeats the
  API's rules, such as the role name's 50 characters and the permission
  key's pattern, so a mistake shows before the request. `TextField` marks
  its input `aria-invalid` and describes it by its `FieldError`. A form
  on the `Admin` page sits in a `FormSheet`, a drawer, and a delete in a
  `ConfirmDialog`. The account page's Roles form sits in its card. A
  409 for a taken name or key lands on that field. Another refusal, such
  as the last administrator, shows the API's title in the form, through
  `ApiError.title`. A save shows a toast.
- `useAdminWrite()` runs each admin write. After it, every admin list and
  the session fetch again (`refreshAfterAdminWrite()` in `queries.ts`),
  because a write can change the visitor's own permissions. Then
  `router.invalidate()` runs the admin route's loader again, so a visitor
  who takes `admin.view` from themselves goes to `/`. `can()` in
  `src/api/permissions.ts` checks the session's permissions, by the
  built-in keys in `Permission`. The API checks every request again.
- `design-system.tsx`: a public page. Public pages go directly in
  `src/routes/`. They make no request and never show the loading screen.
  The design system page has no `AppShell`, and no page links to it.
- `signed-out.tsx`: a public page, with component `SignedOut`
  (`src/pages/SignedOut.tsx`). Auth0 sends the browser there after
  sign-out. It is an `ErrorScreen` that says the visitor is signed out,
  with Sign in (back to `/`) and Play as a guest (a link to `/`). A
  rate-limited sign-in also lands there (see Sign-in), so the screen shows
  `SignInErrorAlert` above its wordmark, with Try again back to `/`. It
  still makes no request.
- `sign-in-stopped.tsx`: a public page, with component `SignInStopped`
  (`src/pages/SignInStopped.tsx`). Auth0's error page sends the browser
  there, such as after Back from a sign-in that worked. It is an
  `ErrorScreen` with Go to FortyMM (a link to `/`) and Sign in again. It
  reads none of Auth0's query, so it shows one message for every error.

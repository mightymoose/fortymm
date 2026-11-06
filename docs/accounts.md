# Accounts, sign-in and roles

How the API's accounts, sessions, sign-in, "Is this you?", roles and leagues work. `api/CLAUDE.md` holds the API's conventions.

## Accounts and sessions

Every visitor gets a guest account the first time the app loads. A guest
account has no `email`. A verified account has one, always lowercase.

- `accounts.py`: `CurrentAccount = GuestAccount | VerifiedAccount`, the
  account of a valid session. An adopted account (`adopted_into` set) is
  neither kind, so its sessions are invalid. `current_account()` in
  `services/sessions.py` decides the kind in one place. It checks `adopted_into` first, then `email`.
- Players are permanent. The `players_are_permanent` trigger refuses every
  `DELETE` on `players`. An account manages players through
  `player_managers`. Each row has `relationship` `self` or `managed`. An
  account has at most one `self` player, and a player at most one `self`
  account.
- `start_session()` gives every account it returns a `self` player
  (`SelfPlayer` in `accounts.py`). A new guest account gets a new player
  with a default display name, such as `excited egret 387`. A resumed
  account that has no `self` player gets one too. That includes an account
  that a sign-in with no session made, and a verified account whose only
  player waits for the "Is this you?" answer. A "Yes" then merges the two
  players (see Is this you?).
- `services/display_names.py` makes the default names: an animal, an
  adjective with the same first letter, and a number from 100 to 999. The
  adjectives are kind or neutral. `lower(display_name)` is unique among
  players with no `merged_into` (the partial index `unique_display_name`).
  So the insert skips a taken name with `ON CONFLICT DO NOTHING` and tries
  another, up to 10 times. A merged player's name is free again. Its test
  fails if an animal's initial has no adjective. `tests/test_schema.py`
  checks the index's `WHERE` clause, because `alembic check` doesn't.
- `ownership.py`: `OWNERSHIP_RULES` says what adoption and player merge do
  to each foreign key to `accounts` or `players`. `tests/test_ownership.py`
  reads every such foreign key from `information_schema`. It fails if one
  has no entry. So a new foreign key to either table needs an entry in the
  same change.
- `POST /v1/session` (`v1/session.py`) starts or resumes the visitor's
  session through `services.sessions.start_session()`. With a valid session, it updates `accounts.last_seen_at`, moves
  `sessions.expires_at` to 400 days from now and sets the same cookie
  again. With no cookie, or an unknown, expired or adopted one, it makes a
  guest account and a session. It deletes the session row that the old
  cookie matched, and keeps that row's account. Every response sets
  `Cache-Control: no-store`. The body is `{"data": {"account": {"id":
  "...", "kind": "guest", "email": null, "player": {"id": "...",
  "display_name": "excited egret 387"}}}}`. A verified account has kind
  `"verified"` and its email. Every account has a `player`.
- `start_session()` limits guest accounts per client network. A network can
  start 30 guest accounts per window of one minute (`GUEST_ACCOUNT_LIMIT`,
  `GUEST_ACCOUNT_WINDOW`). The 31st gets `GuestAccountLimitReached`, and
  `create_app()` answers 429 with `Retry-After`. A resume never counts. A
  sign-in from a browser with no session counts too (see Sign-in). An
  IPv4 address is one network. An IPv6 address counts as its /64. The counts
  live in `guest_account_counts`, so every API instance shares them. Each
  counted start deletes up to 100 rows whose windows ended. So a row lasts
  until the first guest start, from any network, after its window ends. The route reads
  the client address from `request.client`. In production, uvicorn's
  `--proxy-headers` sets it from the `X-Forwarded-For` that the Worker
  writes.
- The cookie is `__Host-fortymm_session`: 32 random bytes in base64url, with
  `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000` (400 days).
  `sessions.expires_at` also ends 400 days after the last `POST
  /v1/session`. The API stores only the token's sha256, in
  `sessions.token_hash`.
- `services/sessions.py`: a session is valid if its `token_hash` matches,
  `expires_at` is in the future and its account has no `adopted_into`.
  `authenticate()` returns the account of a valid session, or `None`.
- `auth.py`: the session and login cookies, and the `RequestAccount`
  dependency. A route that needs the account takes a `RequestAccount`
  parameter. Without a valid session, that dependency answers 401 in the
  `errors` shape. Only `POST /v1/session` makes a guest account.
- A service that writes as an account first calls
  `lock_account_for_write()` in `services/sessions.py`. It holds the account
  row `FOR SHARE` until the transaction ends. After the lock, it checks
  `adopted_into` again. If it is set, it raises `AccountAdopted`, and
  `create_app()` answers 401 in the `errors` shape. So a write can't land on
  a guest account after an adoption moved its data.
  `RequestAccount` takes no lock. `POST /v1/session` locks the account `FOR
  UPDATE`, because it writes `last_seen_at`.
- `alembic check` doesn't compare a partial index's `WHERE` clause. So
  `tests/test_schema.py` checks each constraint, each index and the trigger
  on a `migrated_database`.

## Is this you?

A sign-in can bring players that have played to an account with
`adopted_from` set (see Sign-in). Each one is an open "Is this you?"
question. A player has played once it's in a match, with a result or
not (`services/player_matches.py`), counting the players merged into it.
`services/players.py` holds the rules, and `v1/players.py` the routes.

A `self` row with an open question is the account's own player for now.
It is the guest's player that played, kept by `VerifyInPlace` so the
account plays as it until the person answers. It is provisional: when
another player is confirmed as the person, it becomes `managed`, and its
question stays open. Two things confirm another player: a `yes` for it,
and an unplayed guest's `self` player that `AdoptGuest` brings (see
Sign-in). Every answer leaves the account a `self` player, so it never
plays as a player it said isn't the person.

- `GET /v1/account/players` lists the account's players, its `self`
  player first, then by display name. Each has `relationship`,
  `open_question`, `match_count`, `recent_matches` and `played_against`,
  the account's other listed players that it played. It leaves out merged
  players. `match_count` and `recent_matches` (the latest five, newest
  first) count every match the player is in, with a result or not. A
  match's `played_at` is when it was made, until results record a time.
  Its `opponents` are the display names of the players on the side that
  doesn't name the player, each named by its survivor, in name order.
  `result` comes from the match's current result once it has one, and is
  absent before: `won`, and `games`, the games the player's side won and
  then the other side's. A retired match's unfinished last game counts
  for nobody, and the side that didn't retire won. A match whose two sides
  both merged into the player has no opponents and no `result`.
- `POST /v1/account/players/{player_id}/answer` takes `{"answer": "yes"}`,
  `"no"`, `"not_mine"`, or `"same_as"` with a `player_id`. It returns the
  same list after the answer as `data`, and what the answer did as `meta`.
  `yes` makes the row `self`. If the account already has another `self`
  player with a closed question, `yes` merges the two players instead (see
  below). One with an open question becomes `managed`, with no merge. `no`
  makes the row `managed`. `not_mine` deletes the `player_managers` row.
  The player stays, with no manager. `same_as` merges it with the player that
  `player_id` names. That player must be a `managed` player of the account
  with a closed question. A merge would close an open question with no
  answer. An answer that leaves the account no `self` player, such as `no`
  for its own player, makes one in the same transaction, with
  `ensure_self_player()` in `services/sessions.py`, which `POST
  /v1/session` uses too. So `data` lists it. The review asks about the own
  player last, so in the app that happens only once no other question is
  open.
- `meta.outcome` is `self`, `managed`, `removed`, `merged` or
  `already_answered`. A `merged` outcome also has `survivor`, the id of the
  player that survived, and `merged`, the id of the other. `services/players.py` decides it, as
  `Settled` or `Merged`.
- Every answer clears `adopted_from`. A second answer changes nothing,
  whatever the first answer was, and its outcome is `already_answered`.
- The API answers 409 to `not_mine` for a question already answered, and
  to a `yes` or `same_as` that would merge two players who played each
  other (see below). It
  answers 404 for a player the account doesn't manage, or a merged player.
  It also answers 404 if `same_as` names a player that isn't a `managed`
  player of the account with a closed question. It answers 422 if
  `player_id` is missing with `same_as` or comes with another answer. That
  422 is FastAPI's own `detail` body. A `same_as` that names the answered
  player gets a 422 in the `errors` shape.
- Both routes call `lock_account_for_write()`, and the answer holds the
  account row `FOR UPDATE`, because it may add a `self` player and a row
  lock can't see a row that another answer adds. The answer also locks
  every `player_managers` row of the account `FOR UPDATE`. So two answers
  from two tabs take turns, and the second `yes` merges with the first
  one's player.
- `merge_players()` in `services/player_merge.py` merges a player into
  another player the account manages: the `self` player for `yes`, a
  `managed` player for `same_as`. The original player survives. It is the
  one created first (`players.created_at`, then `id`). It keeps its id and
  display name. Its row takes the relationship of the player it merged
  into, so a `yes` keeps the account's `self` player. The other player gets
  `merged_into` set to the survivor and gives up its display name. Its row
  stays, as `managed` (`STAYS_ON_PLAYER_MERGE`). Both rows lose their
  question. Nothing merges into a `self` player with an open question,
  because it steps down instead. The merge also points
  every player already merged into the merged player at the survivor. So
  `merged_into` always names a player that isn't merged.
- Two players who played each other are two people, so they never merge.
  `merge_players()` raises `PlayedEachOther`, before it writes anything,
  when the two were on opposite sides of a match with a result, rated or
  not. Each counts with the players already merged into it. A match with
  no result doesn't count, because anyone may create one naming any two
  players. `opponents()` in the same module holds the rule, and the list's
  `played_against` comes from it. The merge locks both players and the
  players merged into them `FOR UPDATE` before it checks, so a writer
  that holds a match's side players `FOR SHARE` takes turns with it. No
  route records a result yet, so the tests make their matches with
  `played()` in `tests/played_matches.py`.
- A view that combines a player with the players merged into it comes
  with games.

## Sign-in

Sign-in uses Auth0. Local dev and the tests use a mock OpenID Connect
provider, because Auth0 doesn't accept a random dev port in a callback URL.
Production and the Previews use the real tenant (see Auth0 under Deploy).

- The `oidc` Compose service runs navikt's mock-oauth2-server. Its issuer is
  `http://oidc:8080/default`. Its sign-in page is `oidc/sign-in.html`,
  set by `loginPagePath` in the service's `JSON_CONFIG`. The page has a
  button for each of a few people, such as the administrator
  `mightymoose@fortymm.com`. Its form signs in any `sub` with the claims
  typed into it, such as `{"email": "ann@example.com", "email_verified":
  true}`. The Playwright suite fills that form by its placeholders, so
  they stay as the mock's built-in page has them. It has no published port. From 6.1.0, it puts
  `auth_time` in the ID token when the request has `max_age`, as Auth0
  does, so the callback's check works against it.
- The API reads `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET`.
  `AUTH0_DOMAIN` is Auth0's host, or a base URL with a scheme, such as the
  mock's. Compose points it at the mock. Without `AUTH0_DOMAIN`, the sign-in
  routes answer 503. On Cloud Run, `create_app()` raises if any of the three
  is missing.
- `identity_provider.py` talks to the provider. It finds the endpoints in
  the provider's discovery document, exchanges the code with PKCE and
  verifies the ID token against the provider's JWKS, with the nonce. It
  lowercases the email. It reads `auth_time` into `IdToken`, or `None` if
  the claim is missing or isn't a number.
- The browser can't resolve `oidc`. So in Compose, `AUTH0_AUTHORIZE_URL` is
  `/oidc/default/authorize`, and the web-client dev server proxies `/oidc/*`
  to the mock. The API still reaches the mock at `http://oidc:8080`. The
  tests unset `AUTH0_AUTHORIZE_URL` and `AUTH0_LOGOUT_URL`, and post the
  mock's form directly.
- `GET /v1/auth/login?return_to=...` (`v1/auth.py`) stores a
  `login_attempts` row for 10 minutes and answers 302 to the provider.
  Every sign-in, with no session, a guest or a verified account, and from
  the iOS app too, sends `prompt=login` and `max_age=0`. A sign-out deletes
  FortyMM's session before the browser loads Auth0's logout. If that load
  never finishes, Auth0 still remembers the person, and would sign the next
  person on that browser in as them with no page (#130). `prompt=login` is
  only a hint, which anyone can strip from the URL. `max_age=0` makes
  Auth0 authenticate the person again and put `auth_time` in the ID token,
  which the callback checks. Sessions last 400 days, so asking every time
  costs little. The callback must come from the
  browser that started the attempt. A browser with a valid session proves
  it with that session (`login_attempts.session_id`). A browser without one
  gets no guest account. After a sign-out, a guest account would hold
  nothing, and adoption would merge its new player away at once. Its
  attempt has no `session_id`. The browser gets the attempt's `state` in the
  `__Host-fortymm_login` cookie instead, for 10 minutes, and the callback
  checks that the cookie matches the `state` in its URL. Another browser can
  open that URL, but it can't set this browser's cookie. Such a login
  counts toward the guest account limit, because nothing else bounds it.
  Past the limit, the route answers 302 to
  `/signed-out?sign_in_error=rate_limited&retry_after=<seconds>`, with no
  cookie and no attempt. The seconds are the 429's `Retry-After`, from
  `retry_after_seconds()` in `v1/errors.py`. `return_to` would usually be
  `/`, which would start a guest account and get the same limit.
  `/signed-out` starts none, and it is where such a browser usually clicked
  Sign in. `POST /v1/auth/app-login` still answers 429 with `Retry-After`.
  `return_to` must start with `/`, its second character must be neither `/`
  nor `\`, and it must hold no control character. Any other value becomes
  `/`.
- `GET /v1/auth/callback` runs `finish_sign_in()` in
  `services/sign_in.py`, in one transaction. It locks the attempt `FOR
  UPDATE`, then checks that the callback comes from the browser that
  started it. A callback from another browser, such as a link-preview
  fetcher or an older tab, gets `WrongBrowser`. It changes nothing and
  leaves the attempt, and the code isn't exchanged, so the right browser
  can still finish (#111, #123). Only after the check does it delete the
  attempt. After the code exchange, it fails the sign-in with `failed` if
  the ID token has no `auth_time`, or one earlier than when the attempt
  started (`expires_at` less the 10 minutes), less the token check's clock
  leeway (`LEEWAY_SECONDS`). Then the provider signed in someone it
  remembered rather than asking. `resolve_login()` is a pure function that picks the outcome from the
  current account and the identity's owner. The owner is the account with
  the `sub`, or else the account with the email.
- A browser with no session at login has no current account, unless
  another tab started a guest account meanwhile. With no current account,
  `resolve_login()` gives `SwitchAccount` to the owner, or `CreateAccount`.
  The callback expires the login cookie, except after `WrongBrowser`. That
  cookie may hold a newer tab's `state`, so the newer tab still signs in
  (#136).
- Every outcome gives the browser a new session and token.
  `VerifyInPlace` calls `convert_guest()` in `services/sessions.py`, which
  deletes every session of the guest account. It also calls
  `hand_over_players()` in `services/adoption.py`, with the guest account
  as the target.
- `hand_over_players()` asks "Is this you?" only about a player that has
  played. `has_activity()` in `services/adoption.py` decides it: a player
  in any match, with a result or not, has played. Such a player's
  row gets `adopted_from` set to the guest account (see Is this you?).
  `AdoptGuest` makes it `managed`. `VerifyInPlace` keeps its relationship,
  so the account keeps playing as its `self` player until the person
  answers. A player that hasn't played asks nothing. `VerifyInPlace`
  keeps it as it is, so the guest keeps its player and name. `AdoptGuest`
  merges the guest's `self` player into the target account's `self`
  player, as "Yes" does, so the older player survives. If the target
  account has no `self` player, the guest's becomes it. If the target's
  `self` player has an open question, the guest's becomes the `self`
  player, and the target's one becomes `managed` with its question still
  open. If the two `self`
  players played each other, the guest's stays `managed` with
  `adopted_from` set, an open question, so the sign-in never fails. A
  `managed` player moves as `managed`. It locks the target account row and its
  `player_managers` rows `FOR UPDATE` first, so a `POST /v1/session` that
  makes the account's `self` player meanwhile takes turns with it.
- `AdoptGuest` calls `adopt_guest()` in `services/adoption.py`. It locks
  the guest account row `FOR UPDATE`. It hands the guest's players to the
  target account through `hand_over_players()`. It moves every other
  column whose `OWNERSHIP_RULES` entry is `MOVES_ON_ADOPT`, read from the
  registry at call time. Then it calls `convert_guest()` and sets
  `adopted_into` on the guest account. The API never deletes that row. The
  target account's other sessions stay valid. A new `sub` that adoption
  finds by email gets its `identities` row on the target account.
- A sign-in takes a Postgres advisory lock on the email before it finds the
  owner. So two sign-ins with one new email take turns, and they make one
  account.
- A successful callback answers 302 to the attempt's `return_to` with
  `signed_in=1` added to its query. The web client opens "Is this you?"
  by itself only then.
- A failed callback answers 302 to the attempt's `return_to` with
  `sign_in_error` added to its query: `cancelled`, `email_not_verified`,
  `expired` or `failed`. `WrongBrowser` answers `failed`. It changes no
  account and sets no cookie. A callback whose `state` matches no attempt,
  such as a replay, answers 302 to `/?sign_in_error=used`. The web client
  shows `used` as a neutral message, because the person is often signed in
  already.
- Every outcome deletes the browser's session, so a second tab's sign-in
  ends the session that the first tab's attempt started with. A sign-out
  does too. The attempt stays: `login_attempts.session_id` is `ON DELETE
  SET NULL`, and `started_with_session` records that it had one. Its
  callback gets `WrongBrowser` and answers `failed`, for a guest or a
  verified account, so the person sees that their sign-in didn't happen
  (#134).
- `POST /v1/auth/logout` deletes the session, expires the cookie and
  returns Auth0's `/v2/logout` URL as `data.logout_url`. Its `returnTo` is
  the origin's `/signed-out`, a public page that starts no session. `/`
  would start a new guest account at once, so the sign-out wouldn't show.
  The mock has no `/v2/logout`. So in Compose, `AUTH0_LOGOUT_URL` is the
  mock's OpenID Connect end-session endpoint, `/oidc/default/endsession`,
  through the dev server's proxy. With it set, the URL passes
  `post_logout_redirect_uri` in place of `returnTo`, and the mock sends the
  browser on to `/signed-out`.
- The iOS app signs in through three routes of its own, because its sign-in
  sheet (`ASWebAuthenticationSession`) is a browser with none of the app's
  cookies. `POST /v1/auth/app-login` runs `begin_sign_in()` and returns the
  provider's URL as `data.authorize_url`, which is relative in dev. Its
  `redirect_uri` is `/v1/auth/app-callback`. That route touches nothing. It
  answers 302 to `fortymm://sign-in` with its query, which ends the sheet.
  The app sends that query's `state`, `code` and `error` to
  `POST /v1/auth/app-finish`, which runs `finish_sign_in()` with the app's
  cookies. It answers `data.outcome`: `signed_in` or a `sign_in_error`
  code. `WrongBrowser` is `failed` and keeps the login cookie, and a replay
  is `expired`. A code that another app catches is
  useless without this app's session or login cookie.

## Roles and permissions

An account may do what its roles' permissions let it. Admins edit roles,
permissions and who holds them on the admin page. `services/roles.py` holds
the rules, `services/authorization.py` the check, and `v1/admin.py` the
routes, under `/v1/admin`.

- A permission is a row of `permissions`. Its key is lowercase words of
  letters, digits and `_`, joined by dots, such as `games.record`, at most
  64 characters. The key never changes, because code checks it by key.
- The built-in permissions are the ones the code checks: `admin.view`,
  `roles.manage`, `account_roles.manage`, `signing_keys.revoke`,
  `matches.create`, `matches.override`, `matches.score`, `matches.view` and
  `players.view`. They are the members of `Permission` in `permissions.py`,
  and their rows have `built_in` set. A
  test fails if the two differ, so a new check in code needs a migration
  that adds its row. Nobody can delete a built-in permission (409).
- Admins add other permissions, for code that checks their keys later.
  Deleting one takes it from every role (`ON DELETE CASCADE`).
- A role is a named set of permissions. Its name is trimmed, at most 50
  characters, and unique whatever its case (`unique_role_name`). A role
  that names an unknown permission gets a 422 in the `errors` shape. The
  admin's list of roles gives each its `default` and its
  `account_count`, the accounts that hold it.
- An account holds the roles its `account_roles` rows name, a guest too.
  `permissions_of()` in `services/authorization.py` gives the permissions
  those roles grant.
- A new account gets every default role (`roles.is_default`) as
  `account_roles` rows, through `grant_default_roles()`. Starting a guest
  session and a sign-in that creates an account both call it. After that
  a default role is a role like any other: it can grant any permission,
  be revoked from an account, granted again or deleted. Taking it off an
  account or deleting it changes no other account. The migration makes
  the default role as `User`, with no permissions, and gave it to every
  account that already existed. The partial unique index
  `one_default_role` allows at most one. A guest that adoption merges
  into an account keeps its own rows, and the account keeps its own.
- `POST /v1/session` returns the account's `permissions`: the sorted keys
  that `permissions_of()` gives, custom ones included.
- A route that needs a permission takes `require_permission()` from
  `auth.py`, such as `Annotated[CurrentAccount,
  require_permission(Permission.ADMIN_VIEW)]`. Without the permission, the
  API answers 403 in the `errors` shape.
- Every write takes one Postgres advisory lock (`RBAC_LOCK`), so two
  writes take turns. Under the lock, the write checks the acting account's
  permission again. So two administrators can't revoke each other at once.
- No write may leave zero accounts holding `account_roles.manage`. A
  revoke, a permission taken from a role or a role delete that would do it
  answers 409.
- `email_role_grants` holds a role waiting for an email. A sign-in that
  ends on the account with that email moves it to `account_roles` and
  deletes it, so a later revoke sticks.
- The migration makes the role `Administrator`, with the built-in
  permissions. It grants it to `mightymoose@fortymm.com`: to the account
  if one exists, or else as an email grant. In dev, signing in through the
  mock as that email makes an administrator. The migrations that added
  `signing_keys.revoke`, `matches.create`, `matches.override`,
  `matches.score`, `matches.view` and `players.view` granted each to every
  role that granted `account_roles.manage`, which could already grant
  itself anything. So `matches.score` is off for everyone else until an
  admin grants it, such as to the default role.
- `GET /v1/admin/accounts` lists accounts, at most 50, with
  `meta.has_more`. `view` picks `verified` (the default, by email),
  `guests` or `all`. The last two put the account seen longest ago first,
  for the cleanup of old guests to start from. `search` filters by a
  case-insensitive substring of the email or the self player's name. Each
  account has its `kind`, its email (null for a guest), player,
  `created_at`, `last_seen_at`, the self player's `match_count` and its
  roles. `GET /v1/admin/accounts/{account_id}` is the account's page in
  one request, a guest's too: the same fields, and every role by name with
  `held`. `PUT /v1/admin/accounts/{account_id}/roles` sets the exact set
  of roles of a verified account, and answers 404 for a guest. An adopted
  account isn't listed and answers 404. It doesn't count in a role's
  `account_count`, nor as the account that keeps `account_roles.manage`,
  because it can never act. `services/roles.py` holds the three.
- `GET /v1/admin/players` lists the players no merge replaced by display
  name, at most 50, with `meta.has_more`, each with the account that plays
  as it and how many accounts manage it. `name` filters by a
  case-insensitive substring. `GET /v1/admin/players/{player_id}` is a
  player's page in one request, merged or not: its `created_at`, the player
  it merged into, how many matches it was named in (a player merged into
  it's too), the accounts that manage it with `relationship` and
  `open_question`, and its leagues. `services/player_admin.py` holds both.
- `GET /v1/admin/signing-keys` and `POST
  /v1/admin/signing-keys/{key_id}/revoke` are the admin's view of the
  signing keys (see Signing keys).
- `POST /v1/admin/matches/{match_id}/override` imposes a match's result
  (see Overriding a result in `docs/matches-api.md`).

## Leagues

A league is the scope a match, and later a rating, belongs to. No route
reads leagues yet.

- `leagues` holds them. A league's name follows a role's rules: trimmed, at
  most 50 characters, and unique whatever its case (`unique_league_name`).
- Exactly one default league exists, `FortyMM`, which the migration makes.
  The partial unique index `one_default_league` allows at most one.
- `league_members` says which players are in which league. The
  `players_join_default_league` trigger joins every new player to the
  default league, whatever code inserts it. It raises if there is no
  default league, so the insert fails. The migration put every existing
  player in it, merged players too.
- A league with members can't be deleted (`ON DELETE RESTRICT`).
- A player merge keeps both players' memberships
  (`STAYS_ON_PLAYER_MERGE`).

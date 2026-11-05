# Matches, results and signing keys (API)

The API's side of matches. `references/matches.md` explains the design, and `api/signed-results/README.md` specifies the signed result format.

## Matches

The tables that record matches (#187, #188), and the routes that write
them. `references/matches.md` explains how they fit together,
with a match from start to finish. `models.py` holds the tables, and
`tests/test_schema.py` checks each rule below that the database enforces.
`services/matches.py` holds the rules of making a match, its lock and its
boards, `services/opponents.py` those of picking an opponent,
`services/match_results.py` those of its results, and
`v1/matches.py` the routes, under `/v1/matches`.

- `match_settings` holds a match's rules: `team_size`, `best_of` and
  `rated`. A match is best of 1, 3, 5 or 7. `team_size` is 1, because
  doubles waits for a v2 of the signed result format.
- `matches` names its settings (one row each) and its league. Its `id` is
  made on the client. `created_by` is the account that made it.
  Its state isn't stored. It is final once `current_result_id` is set.
- A match has two `match_sides`, 0 and 1, the indexes the signed result's
  `players` and signer headers use. `match_side_players` puts the players
  on them, a player on one side only. A deferred constraint trigger checks
  at commit that each match has two sides of `team_size` players. So one
  transaction inserts the match, its sides and their players.
- Settings, sides, side players, submissions and approvals never change.
  A trigger refuses each UPDATE and DELETE. A match is never deleted, and
  changes only its `current_result_id`. That starts NULL, and once set it
  only moves to an accepted result of the same match that nothing
  replaces. So a final match stays final, and its current result only
  moves forward.
- `match_results` holds each distinct payload once, a signed result's or
  an override's. A client names a result by the SHA-256 of its payload,
  so the unique index `match_results_by_hash` is on `sha256(payload)`.
  Look one up with `sha256(payload) = :hash`. There is no hash column.
- A match's results form one chain through `replaces_id`, which a
  payload's `replaces` hash resolves to. The unique index `one_successor`,
  on `(match_id, replaces_id)` with `NULLS NOT DISTINCT`, gives a match one
  first result and each result at most one successor. So two counters to
  one result can't both land, and every new result, a correction or an
  override too, replaces the head, the result nothing replaces. A result
  may only replace a row that already exists, so the chain can't loop. A
  result changes only once, when `accepted_at` is set.
- Only the head can be approved. #188's service checks that, under the
  match's lock. The database doesn't, but it never lets a replaced result
  become current.
- `match_submissions` logs every request that sends a match a board, a
  result or an override, accepted or refused, with its body, account,
  network and outcome. A request for a match that never exists leaves no
  row. The current board is the newest accepted `board` row. A result's
  first submission says who sent it and when.
- `match_approvals` counts each (result, key, side) signature once, with
  the signer's account, the player and the authority as they were when it
  was accepted, and the submission that first brought it.
- The signer's and sender's accounts are `KEPT_AS_RECORD` in
  `OWNERSHIP_RULES`: adoption leaves them naming the guest. The players
  are `STAYS_ON_PLAYER_MERGE`.
- `POST /v1/matches` makes a match, through `create_match()`. It takes
  the match's `id`, made on the device, `best_of`, `rated` and `players`,
  side 0's then side 1's. It needs `matches.create`, which no guest
  holds, and the account needn't play in it. The match goes in the
  default league with `team_size` 1. A new match answers
  201, and one that exists with the same details 200, both with only its
  id, `{"data": {"id": "<uuid>"}}`. `create_match()` returns `Created` or
  `Found` with the id, or `Refused`. Other details answer 409
  `match_differs`, whose title names what differs, such as "The players
  and best of differ from the match's". Players are compared side by
  side after resolving `merged_into`, so a request from before a merge
  still fits. A player that doesn't exist answers 422 ("A player of the
  match doesn't exist", `UnknownPlayer`), and so do a player merged into
  another ("A player of the match merged into another player. Pick them
  again", `MergedPlayer`) and one player on both sides ("Both sides of
  the match are the same player", `SamePlayer`). So a new match stores
  exactly the players the device sent, which its scoring link names.
  None of them writes anything. These checks are only for a new match.
  An existing id is looked up first, so a retry after the two players
  merged still finds its match.
- Two creates of one id take turns on an advisory lock on the id
  (`MATCH_LOCK`), because a row lock can't hold a match that isn't there
  yet. The second finds the first's match.
- Only `POST /v1/matches` makes a match. A board, a result or an
  override for a match that doesn't exist answers 404 ("No match has this
  id", `MatchNotFound`) and writes nothing. The other tests insert their
  matches with `add_match()` in `tests/match_setup.py`.
- A write to a match holds its lock, `lock_match()`: the match's row
  `FOR UPDATE`. So every board, result and override for one match takes
  turns. That is also why `one_successor` never fires from the service:
  a second counter waits for the lock, then finds a new head. The index
  stays as the backstop.
- A board or a result carries the match's details, `MatchDetails`: best
  of, rated and the two players in side order. One with other details
  than the match's is refused with `match_differs`, a 409 whose title
  names what differs, such as "The players and best of differ from the
  match's". Players are compared side by side after resolving
  `merged_into`, so a request from before a merge still fits.
- A write that can be refused once its match exists returns an outcome,
  `BoardPushed`, `Recorded` or `Refused`, rather than raising. A
  `Refused` carries a `Refusal`, whose value is the submission's
  `outcome`. So the refused request's submission commits with it. Each
  route turns a `Refused` into an `errors` response through its own
  table, such as `RESULT_REFUSALS`, and returns it rather than raising.
- `POST /v1/matches/{match_id}/boards` takes `{"board": "<hex>"}`, the
  URL fragment's bytes: a draft payload or an envelope. It needs a
  session holding `matches.score`. Only its format is checked, never its
  signatures, because a board settles nothing. It answers 201 with
  `match_id` and `received_at`. The newest accepted board wins, with no
  version (#227 moved the scores to the fragment). It refuses
  `malformed`, `wrong_match`, `match_differs` and `match_final`, a board
  for a match whose result is accepted.
- Every board, result and override for a match that exists is logged in
  `match_submissions`, refused or not, with its body, the session's
  account, the network as the guest limit keys it (`client_network()`)
  and its outcome. `log_submission()` and `log_refusal()` write them.
- No route reads a match yet. The reads come with the pages that need
  them, because `/v1` can't drop a field once a release uses it. The
  tests read the rows through `result_chain()`, `current_result()`,
  `approvals()` and `newest_board()` in `tests/match_setup.py`.
- `GET /v1/matches/opponents` gives the players a new match can pick, as
  `id` and `display_name`. It needs a session. With no `search`, or one
  that trims to empty, it gives the players the account's `self` player
  faced, most recent match first, each once, at most 12. Merges resolve
  on both sides. With text, it gives players with no `merged_into` whose
  display name contains it, whatever its case, by name, at most 20.
  `%` and `_` match themselves. Neither list holds the account's own
  `self` player.
- Pre-play states (scheduled, ready, called) wait for tournaments
  (#189), and player short codes for later (#187).

## Signed match results

Every result reaches the server as an envelope that the players' devices
signed. `api/signed-results/README.md` specifies the format, and
`api/signed-results/vectors.json` holds the test vectors every client
checks (#182). `POST /v1/matches/{match_id}/approvals` checks one and
records it (see Approving a result).

- `signed_results.py` is the codec: `MatchResult`, `encode_payload()`,
  `decode_payload()`, `result_hash()`, `sign()`, `append_signature()`,
  `decode_envelope()`, `qr_text()`, `link()` and `envelope_from_text()`.
  A payload is a CWT claims map in deterministic CBOR, signed in a
  COSE_Sign envelope with ES256. The result's hash is the SHA-256 of the
  payload bytes.
- `decode_envelope()` gives an `UnverifiedEnvelope`, which gives the
  result out only through `verify(keys)`. Before that, it names its
  `kids`, its `match`, its `payload` bytes and its `signatures`, each a
  `Signature` with its kid, side, player and bytes. `verify()` takes each
  key's kid from the key, so a caller can't pair a kid with the wrong
  key. Its `verified` argument names signatures the caller already
  checked over the same payload, such as stored approvals, which need no
  key. `decode_payload()` reads a payload on its own, as a board's draft.
  `BestOf` is 1, 3, 5 or 7, as in the tables (#182).
- A refusal is `Malformed`, `UnknownKey` or `BadSignature`, each with a
  `code`, in that order of precedence. `Malformed` is decided from the
  bytes alone: decode, re-encode with cbor2 canonical, compare, plus the
  exact type of every map key and integer, because Python's dict treats
  `True` as `1`. The order is part of the format, and
  `tests/test_signed_results.py` checks it through the vectors.
- The second signer appends over the received payload bytes and never
  re-encodes them. Base45 (RFC 9285) is vendored in the codec. Base45 and
  base64url decode strictly.
- `signing_keys.py` is the key type: `SigningPublicKey`, valid on
  construction, with its COSE_Key bytes and its `kid`, the RFC 9679
  thumbprint, and `SigningPrivateKey` for the tests and the generator.
  Signatures are raw `r || s`. `tests/test_signing_key_type.py` checks it
  with the RFC's own example. `matches.py` holds `MatchId` and `BestOf`.
- `tests/signed_result_vectors.py` writes `vectors.json`:
  `./bin/mise run api:signed-result-vectors`. Keys, ids and times are
  fixed and ECDSA signing is deterministic, so a rerun writes the same
  bytes. `test_the_committed_vectors_are_fresh` fails on a stale file.
  Changing an existing vector's bytes breaks every client. The generator
  is also the adapter to pycose, a dev dependency and the second
  implementation. The tests have pycose verify every valid vector and
  append every multi-signature vector's last signature byte for byte.
- `test_every_two_signature_qr_text_fits_version_16_at_level_m` holds the
  QR budget, 656 alphanumeric characters. The longest two-signature vector
  is 614. The web client checks the vectors. The iOS app's
  `FortyMMTests` checks them too, and its workflow runs when the file
  changes (see ios-client).
- To add a Python dependency, run `docker compose run --rm --no-deps -T api
  uv add <pkg>` (`uv add --dev <pkg>` for a dev one) and commit
  `pyproject.toml` with `uv.lock`. The production image installs without
  the dev group, so the app can't import one.

## Approving a result

`POST /v1/matches/{match_id}/approvals` takes a signed envelope as
`{"envelope": "<hex>"}` and records it with `record_result()` in
`services/match_results.py`. It kept the URL and the shapes from when it
only checked, and added fields.

- It needs a session holding `matches.score`, which turns scoring on for
  an account. The signatures, not the session, are the authority: anyone
  with the permission who holds the link may send it, and the session's
  account is only logged. The web client shows a 403's title as the
  refusal, like a 409's.
- A result is one payload, stored once in `match_results` and found by
  `sha256(payload) = :hash`. Each signature counts once per (result, key,
  side), as a `match_approvals` row.
- A match that doesn't exist answers 404 before anything else. Then the
  checks run in this order, and the first that fails refuses the
  result. 422: `malformed` ("The envelope isn't a FortyMM signed
  result"), `wrong_match` ("The result is for another match"),
  `unknown_key` ("A signature's key isn't registered, or was revoked"),
  `bad_signature` ("A signature doesn't match the result") and
  `illegal_ending` ("The scores aren't a legal ending to the match").
  Then, under the match's lock, 409 `same_player` ("Both sides of the
  match are now the same player", after a merge of its two players), 409
  `match_differs`, 422 `no_authority` ("A signature's account doesn't
  play as or manage the player it signs for"), 409 `not_head` ("Another
  result replaced this one, so it can't be approved") and 409 `stale`
  ("The result doesn't replace the match's newest result").
- A signature already recorded with the same bytes needs no key. So an
  exact retry answers the result again, whatever its keys' state since,
  and a revoked key's new signatures are `unknown_key`. A signed-out key
  still verifies, because results from a hall upload late.
- A new approval's account must hold a `player_managers` row on the
  player that survives `merged_into`: `self` gives authority `self`, and
  `managed` with no `adopted_from` gives `representative`. An open "Is
  this you?" question gives none, and nor does creating the match. One
  statement reads the key's owner and its rows, so an adoption can't
  come between them. The approval keeps that account, the surviving
  player and the authority.
- Known result, no new approvals: an exact retry, logged as `accepted`.
  Known result with new approvals: it must be the head. New result: its
  `replaces` must be the head's hash, or absent when the match has no
  results.
- A rated result counts once both sides approve it, and an unrated one
  once either side does. A correction of a final match needs both sides,
  rated or not, so two players can't overwrite each other with one
  signature each. When it counts, `accepted_at` is set and
  `matches.current_result_id` moves to it, and the match is final.
- `check_ending()` is pure, with the rules of `checkGame()` and
  `reviewBoard()` in the web client's `board.ts`. A finished game isn't
  level, and its winner has 11 with at most 9 for the loser, or more than
  11 and exactly 2 ahead. A completed match has only finished games, and a
  side reaches its wins at the last game. A retired match has finished
  games but its last, which may be unfinished, and no side has its wins.
  It may have no games.
- It answers 201 with `{"data": {"hash", "match_id", "approvals",
  "accepted_at"}}`. `approvals` are every approval the result has, each a
  `key_id`, `player_id`, `side` and `authority`, sorted by key id, then
  side. `accepted_at` is null until the result counts, and for good once
  another result replaces it first.

## Overriding a result

`POST /v1/admin/matches/{match_id}/override` imposes a result, and needs
`matches.override`. It takes the `games`, the `ending` (`completed` or
`retired` with `retired_by`) and a `reason`. `override_result()` in
`services/match_results.py` holds the rules.

- The server encodes the payload itself, from the match's details, with
  the head's hash as `replaces` and now, in whole seconds, as its time.
- It logs an `override` submission with the administrator's account and
  the payload, and stores the result with the trimmed `override_reason`
  and no approvals. It counts at once.
- So it replaces the current result, or cuts off a counter that waits on
  it. A device still holding a result it replaced gets a 409, and
  players can correct the override the normal way.
- A blank reason (`InvalidOverrideReason`) or scores that aren't a legal
  ending (`IllegalEnding`) answer 422 in the `errors` shape, and an
  unknown match 404, before anything is written. So does a match whose
  sides a merge made one player (`SidesAreOnePlayer`, 409). That check
  holds the side players `FOR SHARE`, as a result's does, survivors first
  as a merge locks them, so a merge that
  races the override waits, then sees its result and refuses.

## Signing keys

Each device holds a P-256 signing key, and the account it signs for holds
the public half, so a signed result's kid names an account (#183).
`services/signing_keys.py` holds the rules, and `v1/signing_keys.py` the
routes, under `/v1/account/signing-keys`. Guests may use them. A
result's signatures are checked against them (see Approving a result).

- `signing_keys` holds one row per key. Its primary key `id` is the kid, 32
  bytes, typed `KeyId` through `Base.type_annotation_map`. `public_key` is
  the 75-byte COSE_Key, and `CHECK (id = sha256(public_key))` ties them.
  `account_id` is `ON DELETE RESTRICT`, because a key attributes results to
  its account, and `MOVES_ON_ADOPT`. `label` is trimmed and at most 50
  characters. `tests/test_schema.py` ties `LABEL_MAX_LENGTH` to the CHECK.
  `revoked_at` is only ever set, never cleared. `revoked_by` names the
  account that revoked the key: its own, or an administrator's.
  `CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))` keeps the two
  together. It is `MOVES_ON_ADOPT`, so a guest's own revoke moves with its
  keys. `signed_out_at` is set by a sign-out or the cap, and cleared when
  the device registers the key again, unless the key is revoked. A live
  key has neither. No column says "live". `_state()` in the service is the
  one rule: revoked wins over signed out, which wins over live.
- The service is the only writer of the table. Its surface is
  `register_key()`, `account_keys()`, `revoke_key()`, `find_keys()`,
  `revoke_any_key()`, `sign_out_device()` and `verification_keys()`. Its
  refusals are `InvalidDeviceLabel`, `InvalidPublicKey` and `InvalidProof`
  (422), `KeyRegisteredElsewhere` (409), and `SigningKeyNotFound` and
  `UnknownSigningKey` (404), mapped in `main.py`'s `SIGNING_KEY_ERRORS`.
- A device registers with `POST /v1/account/signing-keys` and a body of
  `public_key`, `proof` and `label`. Every byte field in this API's JSON is
  lowercase hex, through `HexBytes` in `v1/types.py`. A string that isn't
  gets FastAPI's own 422. `proof` is the key registration proof that
  `api/signed-results/README.md` specifies: a COSE_Sign1 of 160 bytes over
  `{"fortymm/key-registration/v1": {1: <account id>}}`, with the kid in its
  protected header. The `registrations` list in `vectors.json` pins it.
  `SigningPrivateKey.registration_proof()` makes one, for the tests and
  the generator. `SigningPublicKey.verify_registration()` checks one by
  rebuilding the 96 fixed bytes and comparing, then verifying the last 64.
  No CBOR decoder reads the client's bytes. There is no nonce. A replay
  hits the idempotent case below.
- The response is `{"data": {"id", "label", "created_at", "signed_out_at",
  "revoked_at"}}`, with status 200 whether the key is new or already the
  account's. Registering a key the account owns keeps its label and
  `created_at`, so a retry gets the first call's answer. A signed-out key
  is live again: the fresh proof shows the device is back. A revoked key
  stays as it is. A key another account owns answers 409. A bad label, key
  or proof answers 422 in the `errors` shape before any read, so a caller
  without the private key learns nothing about the key. A replay of
  another account's proof is a bad proof, not a 409. A label is trimmed
  with `str.strip()`, then 1 to 50 characters with no control character
  (Unicode category Cc: C0, DEL and C1).
- An account keeps at most 20 live keys (`LIVE_KEY_LIMIT`). A registration
  that leaves its key live, new or back from signed out, signs out the
  oldest live keys by `created_at`, then `id`, past the cap, and keeps
  that key and the newest 19 others. Nothing is refused for
  the cap. The registration locks the account row `FOR UPDATE`
  (`lock_account_for_write(exclusive=True)`), so two registrations take
  turns and the cap holds. The new key is kept by id, not by time. `now()`
  is the transaction's start, so a registration that waited for the lock
  can carry an older time than keys registered meanwhile.
- `GET /v1/account/signing-keys` lists the account's keys, newest first,
  signed out and revoked included.
- `POST /v1/auth/logout` takes an optional body with `signing_key_id`.
  `sign_out_device()` sets `signed_out_at` on the key if the session's
  account owns it, then ends the session. An id that is unknown, another
  account's, already signed out or not 32 bytes of lowercase hex changes
  nothing, so a logout never fails over it. The field is a plain string,
  not `HexBytes`, so a broken id gets no 422 that would leave the session
  in place. The key goes before the session because
  adoption moves a guest's keys before it deletes its sessions. In the
  other order, a logout that overlaps an adoption deadlocks with it. A
  signed-out key still verifies what it signed.
- `POST /v1/account/signing-keys/{kid}/revoke` reports a device
  compromised. It sets `revoked_at` and `revoked_by`, and a second call
  keeps the first time and revoker. A signed-out key can be revoked. It
  answers 404 for a key the account doesn't own, so another account's key
  looks like no key.
- An administrator sees and revokes any account's key, a guest's too,
  under `/v1/admin`. `GET /v1/admin/signing-keys` (`admin.view`) lists
  every key, newest first, at most 50, with `meta.has_more`. Each has its
  `state`, `revoked_by` with `revoked_by_email`, and its account's `id`,
  `email` and self player's `display_name`. `search` keeps the keys whose
  account's email or player name contains it, whatever its case. Empty
  text leaves the filter out, so guests, whose email is NULL, stay. `POST
  /v1/admin/signing-keys/{key_id}/revoke` (`signing_keys.revoke`) revokes
  the key as the administrator, through the same writer as the owner's
  revoke, so the first time and revoker stick. It answers 404 "No key has
  this id" for an unknown kid. It locks the administrator's account, not
  the key's, so a key that adoption just moved still revokes. A revoke
  ends no session. The device finds out at its next registration and
  makes a new key.
- Adoption moves the guest's keys to the target account, as it moves every
  other `MOVES_ON_ADOPT` column. It doesn't trim. The target's next
  registration does.
- `verification_keys(session, kids)` is the results' lookup. It returns
  the keys among `kids` that aren't revoked, signed out or not, each with
  its account and its `signed_out_at`, by kid. A kid missing from the
  result is unknown or revoked, which `UnverifiedEnvelope.verify()`
  refuses as `unknown_key`. Results from a hall upload late, so a
  sign-out refuses nothing, and a signed-out key's signature counts.
- A sign-in that switches accounts doesn't sign out the old account's key.
  The device re-registers its key with a proof for the new account, and
  reads 200 if adoption moved the key there, or 409 if another account owns
  it. Then it makes a new key. Both clients do this (see web-client and
  ios-client).
- `tests/services/test_signing_keys.py` tests the rules,
  `tests/test_account_signing_keys.py` the routes' HTTP work, and
  `tests/test_signing_key_type.py` the key type and the proof.

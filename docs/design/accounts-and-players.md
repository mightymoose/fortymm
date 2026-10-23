# Accounts, players and guest adoption

Every visitor gets an account the first time the app loads. They can play games and never see a login screen. When they sign in later, the account adopts everything they did as a guest. One account can control many players, so a parent can enter a child in a tournament without the child having an account.

## Terms

- **Account.** The thing that signs in, pays and gets email. A row in `accounts`.
- **Guest account.** An account with no identity. Only the session cookie in one browser reaches it.
- **Verified account.** An account with one or more identities. Signing in from any browser reaches it.
- **Identity.** An Auth0 login with a verified email, stored by its `sub` claim. It belongs to exactly one account.
- **Player.** The person who plays. Games, ratings and tournament entries reference a player, never an account. A row in `players`.
- **Manager.** An account that controls a player. One player can have more than one manager, such as two parents.
- **Self player.** The player who is the account holder. An account has at most one self player. A parent who does not play has none.
- **Session.** An opaque token in a cookie that points at one account.
- **Entry.** One player's place in one tournament event. This doc says "enter" and "entry", not "register", so it never confuses a tournament entry with creating an account.
- **Adopt.** A verified account takes over a guest account's players and sessions. The API then marks the guest account as adopted, and nobody can sign in to it again.
- **Player merge.** Two players turn out to be one person. Their games move to the player who carries on, and the other player stops taking part.

## Three premises

The design rests on three rules. Most edge cases below resolve because of them.

1. **History belongs to players.** Games and entries reference `players.id`. No account change rewrites them. A player merge rewrites no game either. Ratings are derived from games and get recalculated.
2. **Adoption moves control, not history.** Adopting a guest changes `player_managers` rows. No game or entry row changes, so a match in progress or an open entry stays valid during adoption.
3. **Players outlive accounts.** A player with no manager is legal. A walk-in that a tournament director adds has no manager. So does the player of a deleted guest account. Nothing ever deletes a player. A player's games are also their opponents' games, and every rating came from them.

## Keep Auth0 out of guest creation

The API creates guest accounts itself. The API calls Auth0 only when someone signs in.

| Option | What happens | Verdict |
| --- | --- | --- |
| First-party guest accounts, Auth0 at sign-in | The API creates an `accounts` row and a session cookie. Auth0 sees the person only when they sign in. | Chosen. |
| [Auth0 Anonymous Sessions](https://auth0.com/docs/manage-users/sessions/anonymous-sessions) | Auth0 issues anonymous tokens from `POST /anonymous/token`. | Rejected. The feature is a beta for paid plans, and Auth0 support must admit the tenant. |
| An Auth0 user per visitor | The API creates an Auth0 user through the Management API on first load. | Rejected. Every crawler becomes an Auth0 user. That costs monthly active users and hits Management API rate limits. |

No Auth0 token ever reaches browser JavaScript. Guest and verified accounts use the same session cookie.

## Data shape

```sql
create table accounts (
  id uuid primary key default gen_random_uuid(),
  adopted_into uuid references accounts (id),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table identities (
  auth0_sub text primary key,
  account_id uuid not null references accounts (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table account_emails (
  email text primary key,                -- verified by Auth0, lowercased
  account_id uuid not null references accounts (id) on delete cascade
);

create table players (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  merged_into uuid references players (id),
  created_at timestamptz not null default now()
);

create function refuse_player_delete() returns trigger language plpgsql as $$
begin
  raise exception 'players are never deleted';
end $$;
create trigger players_are_permanent before delete on players
  for each row execute function refuse_player_delete();

create table player_managers (
  player_id uuid not null references players (id),
  account_id uuid not null references accounts (id) on delete cascade,
  relationship text not null check (relationship in ('self', 'managed')),
  adopted_from uuid,                     -- the guest account it came from, until the "is this you?" prompt is answered
  primary key (player_id, account_id)
);
create unique index one_self_player_per_account
  on player_managers (account_id) where relationship = 'self';
create unique index one_self_account_per_player
  on player_managers (player_id) where relationship = 'self';
create unique index unique_display_name on players (lower(display_name));

create table sessions (
  token_hash bytea primary key,          -- sha256 of the cookie value
  account_id uuid not null references accounts (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table login_attempts (
  state text primary key,
  session_token_hash bytea not null references sessions (token_hash) on delete cascade,
  intent text not null check (intent in ('sign_in', 'add_login')),
  code_verifier text not null,
  nonce text not null,
  return_to text not null,
  expires_at timestamptz not null
);
```

Deleting an account cascades to its sessions, identities, emails and `player_managers` rows. It never cascades to `players`. The `players_are_permanent` trigger makes any `DELETE` on `players` fail, so a bug or a manual query cannot remove one either.

`player_managers` is a join table from the start, even though the first UI allows one manager per player. Two parents who each create the same child would otherwise make two players and two entries. A later change from one manager to many would rewrite every query that reads the manager.

The two partial unique indexes make "two self players in one account" impossible in the database. The primary key on `account_emails.email` makes "one email, two accounts" impossible too.

In Python, the API brands the ids and reads an account into a discriminated union:

```python
AccountId = NewType("AccountId", UUID)
PlayerId = NewType("PlayerId", UUID)

@dataclass(frozen=True)
class GuestAccount:
    id: AccountId

@dataclass(frozen=True)
class VerifiedAccount:
    id: AccountId
    emails: tuple[str, ...]  # never empty

Account = GuestAccount | VerifiedAccount
```

A function that takes a `PlayerId` rejects an `AccountId` at type-check time. Responses carry `"kind": "guest" | "verified"`.

### Every table that points at a player or an account declares its rule

Adoption and player merge must know about every table that references `players` or `accounts`. A future table that nobody adds to them would leave rows behind. So the API keeps one registry:

```python
OWNERSHIP_RULES: dict[tuple[str, str], OwnershipRule] = {
    ("player_managers", "account_id"): OwnershipRule.MOVES_ON_ADOPT,
    ("player_managers", "player_id"): OwnershipRule.STAYS_ON_PLAYER_MERGE,
    ("sessions", "account_id"): OwnershipRule.MOVES_ON_ADOPT,
    ("identities", "account_id"): OwnershipRule.GUEST_HAS_NONE,
    ("account_emails", "account_id"): OwnershipRule.GUEST_HAS_NONE,
    ("players", "merged_into"): OwnershipRule.SET_BY_PLAYER_MERGE,
    ("accounts", "adopted_into"): OwnershipRule.SET_BY_ADOPT,
    # Later: ("games", "player_a_id"): RESOLVED_THROUGH_MERGED_INTO,
    # ("entries", "player_id"): MOVES_ON_PLAYER_MERGE,
    # ("payments", "payer_account_id"): KEPT_AS_EVIDENCE,
}
```

The registry has one entry per foreign key column, because one table can point at an account in two ways with different rules. A test reads every foreign key to `players` and `accounts` from `information_schema`. It fails if a foreign key column has no entry in `OWNERSHIP_RULES`. A new table cannot ship until someone decides what adoption and player merge do with it.

## Start a guest on the first load

1. The SPA sends `POST /api/v1/session` while the loading screen shows. It sends the request on every page load.
2. If the request carries a valid session cookie, the API updates `last_seen_at` and returns that account.
3. If the request carries no cookie, or an expired or unknown one, the API creates a guest account and a session. It returns the new account with a `Set-Cookie` header.

The request is idempotent. A second call with the cookie it set returns the same account.

The API creates the guest account's self player later, when the guest first plays. An account with no self player is legal anyway, so this adds no new state.

The cookie is `__Host-fortymm_session=<32 random bytes, base64url>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000`. That is 400 days, the most Chrome keeps. Each `POST /v1/session` slides `expires_at` and `Max-Age` forward. The API stores only a hash of each token.

The SPA creates the guest account, not the Worker or the HTML response. Crawlers that do not run JavaScript then never create an account.

```json
{"data": {"account": {"id": "6f1c…", "kind": "guest"}}}
```

### Why cookies work with no CORS

The Worker forwards every request header, `Cookie` included, to the API (`new Headers(request.headers)` in `web-client/worker/index.ts`). It returns the API's response as is, with `redirect: 'manual'`. So `Set-Cookie` and the API's redirects to Auth0 reach the browser unchanged. The Vite dev server's proxy does the same in dev.

### One host, one cookie jar

`fortymm.com`, `www.fortymm.com` and `fortymm.mightymoose.workers.dev` all serve production today. Each host has its own cookies, so one person could get three guest accounts. The Worker answers a request on `www.fortymm.com` or `fortymm.mightymoose.workers.dev` with a 301 to the same path on `fortymm.com`. The Worker names these two hosts exactly, because every Preview runs the same Worker code on its own host.

## Sign in

Adding an email and signing in are one flow. The person types an email at Auth0 and proves it with a code, or uses Google. The API then decides what the identity means.

1. The web-client links to `GET /api/v1/auth/login?return_to=/some/path`. The "Add another login" button in settings adds `intent=add_login`.
2. If the request has no valid session cookie, the API first creates a guest account and a session, as `POST /v1/session` does. A stale tab or a shared link can start a sign-in with no session.
3. The API makes a `state`, a `nonce` and a PKCE `code_verifier`. It stores them in `login_attempts` with the intent, tied to the current session, for 10 minutes.
4. The API answers 302 to Auth0's `/authorize` with `response_mode=query`. If the current account is verified, it also sends `prompt=login`. Without it, Auth0's own session signs the same person in again with no screen. The `redirect_uri` is `https://<X-Forwarded-Host>/api/v1/auth/callback`.
5. The person signs in at Auth0. Auth0 redirects to the callback with `code` and `state`. A `SameSite=Lax` cookie rides this cross-site top-level `GET`. It would not ride a cross-site `form_post`, so the flow pins `response_mode=query`.
6. The API finds the `login_attempts` row by `state` and checks that it belongs to the current session. Then it deletes the row.
7. The API exchanges the code with its client secret and verifies the ID token against Auth0's JWKS, including the `nonce`. If `email_verified` is not `true`, the API stops and the account stays as it was.
8. The API finds the identity's owner: the account with that `sub`, or else the account in `account_emails` for the email.
9. The API resolves the login (next section), applies the outcome and rotates the session token. All of this runs in one transaction. Every outcome that attaches an email inserts into `account_emails`. If two browsers verify the same new email at once, the primary key fails one insert. That transaction rolls back and retries from step 8, where it now finds an owner.
10. The API answers 302 to `return_to`. It accepts `return_to` only if it starts with `/` and its second character is neither `/` nor `\`. Browsers read `//` and `/\` as the start of another host. Any other value becomes `/`.

Auth0 checks the email before the callback runs. The API therefore never holds a pending, unverified email. An unverified email cannot make a guest account look verified, which was the bug in [mightymoose/fortymm-real#1294](https://github.com/mightymoose/fortymm-real/issues/1294). A guest who types an email that another account owns gets a code in that inbox, which only the owner can read. If the guest cannot finish, nothing changes.

Step 8 links by email so that Google and an email code for the same address reach one account. Auth0 gives those two logins different `sub` values. The API links them only when Auth0 says the email is verified. Linking by email is only as safe as the weakest connection's email check. So the tenant enables only the email code and Google connections, and any other connection needs a review first.

Rotating the token in step 9 stops session fixation. The API inserts a new session row and deletes the old one. It never updates the primary key, because `login_attempts` references it.

### Resolve the login in one pure function

```python
@dataclass(frozen=True)
class VerifyInPlace:     # guest account, new identity
    account: AccountId

@dataclass(frozen=True)
class AlreadySignedIn:   # identity already belongs to the current account
    account: AccountId

@dataclass(frozen=True)
class AdoptGuest:        # guest account, identity belongs to another account
    guest: AccountId
    into: AccountId

@dataclass(frozen=True)
class SwitchAccount:     # verified account, identity belongs to another account
    to: AccountId

@dataclass(frozen=True)
class CreateAccount:     # verified account, new identity, intent sign_in
    pass

@dataclass(frozen=True)
class AddLogin:          # verified account, new identity, intent add_login
    account: AccountId

@dataclass(frozen=True)
class EmailTaken:        # verified account, identity belongs to another account, intent add_login
    pass

LoginOutcome = (
    VerifyInPlace
    | AlreadySignedIn
    | AdoptGuest
    | SwitchAccount
    | CreateAccount
    | AddLogin
    | EmailTaken
)

def resolve_login(current: Account, owner: AccountId | None, intent: Intent) -> LoginOutcome: ...
```

| Current account | Identity owner | Outcome |
| --- | --- | --- |
| Guest | Nobody | `VerifyInPlace`. The API attaches the identity. The account keeps its `id` and its self player. |
| Any | The current account | `AlreadySignedIn`. Nothing changes. |
| Guest | Another account | `AdoptGuest`. See the next section. |
| Verified | Another account, intent `sign_in` | `SwitchAccount`. The session points at the other account. Neither account changes. |
| Verified | Another account, intent `add_login` | `EmailTaken`. Nothing changes. Settings shows "That email belongs to another account." |
| Verified | Nobody, intent `sign_in` | `CreateAccount`. The API creates a new verified account with the identity and points the session at it. |
| Verified | Nobody, intent `add_login` | `AddLogin`. The API attaches the identity to the current account. |

A verified account never gains an email by accident. Only the explicit "Add another login" button attaches a second identity.

Two verified accounts never merge. That needs proof of both inboxes in one flow, and this design does not include it.

Unit tests cover `resolve_login` with no database or Auth0. The callback route loads the inputs, calls it and applies the outcome.

### Adopt a guest account

`AdoptGuest` runs in the callback's transaction:

1. Lock the guest account row with `SELECT … FOR UPDATE`.
2. Move each of the guest account's `player_managers` rows to the target account. Every moved row arrives as `managed`, with `adopted_from` set to the guest account. A guest's self player could be a child on a parent's computer, so adoption never makes it the self player on its own.
3. Move every other row whose rule in `OWNERSHIP_RULES` is `MOVES_ON_ADOPT`. That includes the guest account's other sessions, so another tab in the same browser follows the person.
4. Set the guest account's `adopted_into` to the target account. The API keeps the row, because a payment the guest made still names it as the payer. The target account can see every payment made by an account it adopted.

Any write that acts as an account first takes `SELECT … FOR SHARE` on that account's row. A guest tab that creates a player while adoption runs therefore waits. When the lock frees, the account has `adopted_into` set, so the request reads its session again. The session now points at the target account, and the request continues as that account. No player ends up attached to an adopted account.

The operation converges. If the transaction fails, nothing changed, and the person can sign in again. A replayed callback finds no `login_attempts` row, because the first run deleted it in the same transaction. It answers with a redirect to `/` and changes nothing.

After adoption, the web-client shows what moved, such as "We added 12 games played on this device to your account."

For each moved player with `adopted_from` set, the web-client asks "Is Guest 4821 you?":

- **Yes, and the account has no self player.** Guest 4821 becomes the self player.
- **Yes, and the account has a self player.** The app starts a player merge of Guest 4821 into the self player, and Guest 4821's games move to it.
- **No, it is someone else.** Guest 4821 stays a managed player, for example a child who played on the parent's computer.
- **Not mine.** This handles a shared computer, such as a library. The API removes the `player_managers` row, so the player has no manager. It refuses if the player has an entry or a payment, and tells the person to contact the tournament director.

Every answer clears `adopted_from`. The question stays on the account's home page until someone answers it. "Not mine" is available only while `adopted_from` is set.

Adoption itself is never optional at sign-in. The person cannot sign in on this browser and leave the guest account behind. That rule closes the "signed in without adopting" path on one browser. The edge cases below cover other browsers.

### Sign out

`POST /api/v1/auth/logout` deletes the session row and expires the cookie. It answers with Auth0's `/v2/logout` URL, which the web-client follows so that Auth0's own session also ends. The next page load creates a new guest account.

## Merge two players who are one person

A person who played as a guest can make those games count for the player they already have. For example, Ryan signs out, plays a game as Guest 4821 and then signs in as Ryan. The app asks "Is Guest 4821 you?" A yes moves the game to Ryan. Adoption never runs a merge on its own.

The person who asks must manage both players. They pick the player who carries on, called `target`. The other player is `source`.

Ratings come from Elo or a system like it. Elo is a replay of every game in time order. Each game's change depends on both players' ratings just before it. So ratings are derived data, not history, and a merge needs a recalculation. Once the games of `source` count as `target`'s, `target`'s rating before each later game changes. That changes the result for each later opponent of `target`, then for their later opponents, and so on forward in time. So other players' ratings can change too.

So a merge does not rewrite game rows. Each game stays recorded with the two players who played it. The merge sets `source.merged_into = target`, and everything that reads games resolves each player to the player who carries on:

```sql
create view canonical_players as
  select id, coalesce(merged_into, id) as canonical_id from players;
```

`merged_into` always points at a player with no `merged_into` of its own. When a player that others were merged into is merged in turn, the merge points those others at the new `target` too. So the view needs one step, never a chain.

A merge runs in one transaction:

1. Lock both player rows with `SELECT … FOR UPDATE`, lower id first. Code that starts a game or creates an entry takes `FOR SHARE` on its player rows, so it waits for the merge.
2. If `source.merged_into` is already set, stop. A repeated merge changes nothing.
3. Handle entries event by event. Entries are live state with `UNIQUE (event_id, player_id)`, so they move as rows:
   - If only `source` has an entry, the entry moves to `target`.
   - If both have an entry and the draw is not made, the merge keeps one entry and withdraws the other. It keeps the paid entry if only one is paid, or else the older entry. The withdrawn entry stays on `source` with a withdrawn status.
   - If both have an entry and the event has a draw but has not finished, the merge refuses. The tournament director withdraws one entry first.
   - If both have an entry and the event has finished, both entries stay as they are.
   - If both entries are paid, the merge keeps one admission and lists the second payment for manual reconciliation. It never refunds automatically. This follows [mightymoose/fortymm-real#1779](https://github.com/mightymoose/fortymm-real/issues/1779).
4. Set `source.merged_into = target`, and point every player merged into `source` at `target`.
5. Ask the rating system to replay every game from the earliest game of `source` or `target` onward.

From then on, `source` cannot start a game or create an entry. A link to `source` opens the profile of `target`, which lists the games of both players. `source` keeps its `player_managers` rows.

### The rating input drops games against oneself

The rating system reads games through `canonical_players`. It drops any game whose two players resolve to the same player. A game that Guest 4821 played against Ryan stays on record as Guest 4821 against Ryan. After the merge it no longer counts toward any rating, because one person cannot gain or lose rating against themselves.

Because the merge rewrites no game rows, `CHECK (player_a_id <> player_b_id)` always holds, and the record shows each game as it was played.

### A recalculation never changes a draw

A recalculation can change any rating, including ratings used to seed a draw that is already made. So when a director makes a draw, each entry stores the rating that seeded it. A later recalculation changes the ratings shown on profiles, but never a seed that a draw used.

Player merge lands with games, the first table that references `players`.

## Guest accounts can enter tournaments

A guest account can create an entry and pay for it, with no sign-in step. The entry form offers sign-in but does not require it: "Sign in so you can manage this entry from any device."

An entry on a guest account is reachable from one browser only. Three rules keep that safe:

- The "Not mine" choice after adoption refuses for any player with an entry or a payment.
- The stale-account cleanup never deletes a guest account whose players have an open entry, or that a payment names as the payer.
- The checks in the next section catch one person entered twice where the data allows it.

We considered requiring sign-in before the first entry. That removes guest entries on forgotten accounts at the source. We rejected it because it adds a sign-in step to the first entry.

Events and entries must keep these invariants when they arrive:

- An entry references `player_id`, never `account_id`.
- `UNIQUE (event_id, player_id)`.
- A payment references the payer `account_id` and the `entry_id`, and its rule is `KEPT_AS_EVIDENCE`.
- Each new table has an `OWNERSHIP_RULES` entry.

### Catch one person entered twice

Display names are unique, ignoring case. The API gives each guest player a generated name, such as "Guest 4821", and picks another number if that name is taken. Unique names mean two players never look alike. They also mean a name cannot reveal that two players are one person, because that person's two players have two different names. So `UNIQUE (event_id, player_id)` is the only check the database can make on its own.

These checks remain:

- **An unanswered "Is this you?" question.** Suppose an account has an adopted player with `adopted_from` set, and its self player has an entry in the event. The API then refuses to enter the adopted player, and asks the question first. The same holds the other way round.
- **A yes before the draw.** The player merge withdraws one of the two entries.
- **Guest entries are visible to the director.** The director's entry list marks each entry on a guest account. Those are the entries that can turn out to be someone's second player.

One case has no automatic check. A person enters on device 1 as a guest, then enters again on device 2 from another account, before device 1 signs in. The event then has two entries under two names. When device 1 signs in, adoption and the "Is this you?" question remove the extra entry, if it is before the draw. After the draw, the director withdraws one entry. Only a manager of both players can run a player merge.

A tournament with no extra checks leaves this gap open. The first goal is that a person can start a quick tournament with friends, and an extra field on every entry slows that down. A tournament that needs more turns on the checks in the next section.

### Tournaments can turn on extra entry checks

Each event has a set of entry requirements. A new event has none, so a quick tournament asks for nothing beyond a player. A director turns requirements on for a larger tournament.

```python
class EntryRequirement(StrEnum):
    VERIFIED_ACCOUNT = "verified_account"  # the entrant's account has an identity
    DATE_OF_BIRTH = "date_of_birth"        # the player has a date of birth
    DUPLICATE_CHECK = "duplicate_check"    # flag entries with the same date of birth and a similar name

REQUIRES: dict[EntryRequirement, frozenset[EntryRequirement]] = {
    EntryRequirement.DUPLICATE_CHECK: frozenset({EntryRequirement.DATE_OF_BIRTH}),
}
```

- The event stores its requirements as a set of `EntryRequirement` values. The API refuses a set that breaks `REQUIRES`, so a duplicate check never runs without the date of birth it compares.
- At entry time, the API checks each requirement in the set. A missing one makes the entry form ask for it. For `VERIFIED_ACCOUNT`, that means the sign-in flow, which comes back to the form.
- `DUPLICATE_CHECK` flags a pair of entries in the event for the director. The director withdraws one entry or marks the pair as two different people. The draw cannot start while a flag is open.
- If a director turns a requirement on after entries exist, the earlier entries stay. The director's entry list marks each entry that does not meet the new requirement.

A new check is a new `EntryRequirement` value with one check function. Code that creates entries does not branch on the type of tournament.

## Edge cases

### Your scenario: a guest plays, enters a tournament and signs in

Steps: a guest plays games as Guest 4821. The guest enters tournament T as Guest 4821. Then they notice they are not signed in, and sign in.

| What they do next | Result |
| --- | --- |
| Sign in on the same browser with a new email | `VerifyInPlace`. The account and Guest 4821 keep their ids. One entry. |
| Sign in on the same browser to an existing account with no self player | `AdoptGuest`. The app asks "Is Guest 4821 you?" A yes makes Guest 4821 the self player. One entry. |
| Sign in on the same browser to an existing account whose self player is Ryan | `AdoptGuest`. Guest 4821 becomes managed. The app asks "Is Guest 4821 you?" A yes starts a player merge. If Ryan also has an entry in T, the merge withdraws one before the draw and refuses after it. |
| Same as above, but Guest 4821 played Ryan before signing in | The game stays on record as Guest 4821 against Ryan. Ryan's profile lists it, but no rating counts it. |
| A verified account signs out, plays a game as a guest, then signs back in | Adoption moves the guest's player to the account. A yes to "Is Guest 4821 you?" merges the guest's player into the account's self player. The game shows on the self player's profile, and the ratings are recalculated. |
| Sign in on another device as Ryan and enter T again | The guest account stays alive on the first device. T has two entries for one person, under two names. No check catches this. When the first device signs in, adoption and the "Is this you?" question remove the extra entry before the draw. After the draw, the director withdraws one. |
| Clear cookies before signing in | The guest account is unreachable. Guest 4821 keeps the entry, with no manager. The director sees it and can withdraw it. |

### Other cases

| Case | Result |
| --- | --- |
| A guest account signs in with a new email | `VerifyInPlace`. Nothing moves. The self player stays the self player. |
| A guest types an email another account owns, and is not the owner | Auth0 sends the code to the owner's inbox. The guest cannot finish, and nothing changes. |
| A person signs in with Google, and later with an email code for the same address | Step 8 links by verified email. Both logins reach one account. |
| A verified account signs out, a child plays, and the parent signs back in | The child's games are on a new guest account. Adoption moves them to the parent. The parent answers "No, it is someone else", and the child's player stays managed. |
| Someone signs in on a library computer that another person's guest account used | Adoption moves the other person's player. "Not mine" removes it from the account. |
| Two parents each create the same child | Two players exist, with two different names. If both parents enter the child in one event, no check catches it, and the director withdraws one. A co-manager invite lets the second parent manage the first parent's player instead. |
| A child grows up and wants their own account | The parent invites the child's verified account to become a manager with relationship `self`. The parent can then remove their own `player_managers` row. |
| A verified account signs in with a new email on purpose | `CreateAccount`. The person gets a second, empty account. "Add another login" is the way to attach an email to an account. |
| Two tabs: one creates a player while the other finishes adoption | The row locks serialize them. The new player ends up on the target account. |
| The callback is replayed, or the API crashes mid-adoption | The transaction either completed or did nothing. A replay finds no `login_attempts` row and changes nothing. |
| A guest account stays idle for 90 days | If its players have no open entry and no payment names it, the cleanup deletes the account and its sessions. Its players stay, with no manager. |
| A guest enters and pays, then signs in to an existing account | Adoption moves the player and keeps the guest account row. The payment still names the guest account as payer, and the existing account can see it. |

## Guard the endpoints

- **CSRF.** `SameSite=Lax` stops cross-site `POST` requests from carrying the cookie. The API also rejects a `POST`, `PUT`, `PATCH` or `DELETE` without `Content-Type: application/json`. A plain HTML form cannot send that type.
- **Guest floods.** The Worker's limit of 100 `/api/*` requests a minute per IP allows about 144,000 new guest accounts a day from one IP. The Worker gets a second `ratelimits` binding of 30 a minute per IP on every `POST /api/v1/session`. A person sends one per page load, so only a script reaches it. The limit cannot depend on the cookie, because a script can send a fake one.
- **Stale guest accounts.** Each `POST /v1/session` that creates a guest account also deletes up to 100 stale guest accounts. A stale guest account has a `last_seen_at` more than 90 days old, no player with an open entry and no payment that names it. Adopted accounts follow the same rule. The cleanup never touches players. Cloud Run has no cron, and this needs no Cloud Scheduler job.
- **Post-deploy suite.** Every push to `main` loads `/` against production and creates one guest account. The cleanup removes them.

## Configuration and secrets

There are two Auth0 applications of type Regular Web Application, in one tenant:

| Application | Allowed callback URLs | Allowed logout URLs | Used by |
| --- | --- | --- | --- |
| `fortymm` | `https://fortymm.com/api/v1/auth/callback` | `https://fortymm.com/` | `api` |
| `fortymm-preview` | `https://*-fortymm.mightymoose.workers.dev/api/v1/auth/callback` | `https://*-fortymm.mightymoose.workers.dev/` | `api-preview` |

Auth0 [allows a wildcard with a prefix or suffix in the same label](https://auth0.com/docs/get-started/applications/wildcards-for-subdomains), but warns against wildcards in production. The production application lists exact URLs only. Nobody has tested the Preview pattern yet.

The API reads `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET`. The client secrets live in Secret Manager as `auth0-client-secret` and `auth0-preview-client-secret`. Only `api-runtime` and `api-preview-runtime` can read them, which matches the database password secrets. `create_app()` raises on Cloud Run if any of the three is missing.

## Local dev and tests use a mock identity provider

Auth0 does not accept a wildcard port in callback URLs, and Docker gives the dev server a random host port. So local dev, `api:test` and `web-client:e2e` do not talk to Auth0. Compose gets an `oidc` service that runs a mock OpenID Connect provider, and `AUTH0_DOMAIN` points at it. The mock signs in any user it is told to, so the e2e suite can run every sign-in outcome.

The Preview deploy is the first place that talks to the real Auth0. The post-deploy suite checks that `GET /api/v1/auth/login` answers 302 to the tenant's `/authorize`. It does not sign in.

## Delivery

Each phase is one PR that ends in a check.

1. **Migrations.** Add a migration runner that applies plain SQL files in order under a Postgres advisory lock. Check that two API instances started together apply each migration once.
2. **Guest accounts.** Add `accounts`, `sessions`, `players`, `player_managers`, the `OWNERSHIP_RULES` test, `POST /v1/session`, the SPA's call on load and the Worker's host redirect. Check in e2e that a reload keeps the same account `id` and a new browser context gets a different one.
3. **Sign-in and adoption.** Add `identities`, `login_attempts`, the `oidc` Compose service, the login, callback and logout routes, `resolve_login` and adoption. Check every row of the outcome table in e2e against the mock.
4. **Auth0.** Add a step-by-step setup script for the two Auth0 applications, which a person runs in the Auth0 dashboard. Add the two Secret Manager secrets to `api/deploy/bootstrap-gcp.sh` and wire them into `cloud-run-deploy`. Check the post-deploy `/authorize` redirect on a Preview.
5. **Abuse limits.** Add the session rate limit and the stale-account cleanup. Check both with unit tests.
6. **Player merge.** Build it with games. Add `CHECK (player_a_id <> player_b_id)` to games, so no game has the same player on both sides. Check each entry rule in tests. Check that a merge rewrites no game row and that the rating input drops games against oneself. Check that a second run of a merge changes nothing.

## Open decisions

Each decision below has a default that the design already uses.

- **Contacting guest entrants.** A guest entry has no email, so a director cannot send it a schedule change. Default: the director sees which entries are on guest accounts, and the entrant sees changes on the event page. The other choice asks for a contact email on the entry form. That email would not verify the account.
- **The adopted player's role.** Default: an adopted player always arrives as managed, and the app asks "Is this you?" The other choice makes it the self player or merges it at once. That skips a question, but it is wrong for a child who played on a parent's computer.
- **Guest lifetime.** Default: 90 days idle. A shorter time loses accounts of people who play rarely.
- **Lost guest accounts.** A guest who clears cookies or changes browsers without signing in loses the account. Default: accept this, and show "Sign in to keep your games" after the first game.
- **Verified account merge.** Default: not supported. A person with two verified accounts keeps both.
- **Games against your own second player.** One account can manage two players and start a game between them, such as a parent and a child. If both players are the same person, the game is a rating game against oneself. Default: allow it, because the app cannot tell the two cases apart. If the person merges the two players later, the rating input drops those games. The other choice makes games between two players of one account unrated.
- **When to recalculate.** Default: each merge replays every game from the earliest game of the two players onward. An Elo replay is one pass over the games in time order, so it is cheap at first. The rating design can make it incremental later.
- **Previews share one database.** Every Preview uses `fortymm_preview`. A branch that adds a migration applies it to the database that all Previews use. Phase 1 needs a rule for this, for example that migrations only add tables and columns.

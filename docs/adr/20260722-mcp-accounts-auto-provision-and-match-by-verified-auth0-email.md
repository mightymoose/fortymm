# MCP accounts auto-provision and match by verified Auth0 email

Amended by [Accounts authorize durable Players](20260905-accounts-authorize-durable-players.md): sporting identity belongs
to Player; authentication and preserved historical authorship belong to Account.
The linked decision supersedes conflicting identity and merge-ownership clauses.


Date: 2026-07-22 (date-numbered — sequential numbers collide across concurrent
worktrees; see the note in
`20260718-the-match-flow-is-shared-services-behind-http-and-mcp-adapters.md`)

## Status

Accepted — from GitHub issue #1157.

**Supersedes decision #4** of
`20260722-the-mcp-server-is-an-oauth-resource-server-trusting-auth0.md`
("Identity is bound by an explicit, in-session link — not email-matching or
auto-provisioning"). That ADR's other decisions stand unchanged: Auth0 is still
authentication-only, authorization is still fortymm RBAC gated by `mcp.access`
(#3/#5), the verifier is still a stateless `RemoteAuthProvider`/`JWTVerifier`
(#1/#2), and — as originally decided here — the in-session link flow
(`/v1/auth0/link/*`) was initially **kept** as a second, still-valid way to bind
an identity. Only the "explicit link is the *only* way in, we store `sub` only,
no email" stance is reversed here.

> **Amended by #1159 (2026-07-23).** The in-session link flow kept as a "second
> way to bind" above has since been **removed** — auto-provision/match by
> verified email is now the *only* MCP onboarding path. With auto-provision
> covering the ephemeral-account case the manual link step addressed, keeping a
> redundant second binding path was net friction and dead surface, so
> `app/auth0_link.py`, the `/v1/auth0/link/*` routes, and the Settings → *Agent
> access* UI were deleted (alongside the unrelated opaque API-token flow).

## Context

The explicit in-session link step assumed every agent user already has a
confirmed-email fortymm account to link. That fights fortymm's ephemeral-account
model: most accounts start as anonymous guests with no email, so "match a
verified Auth0 email to an existing account" usually has nothing to match, and
the manual `/settings → Agent access → Connect` step is friction on top. The
goal is "add the connector, log in, done" — zero human steps.

## Decision

**At MCP token time, resolve an unlinked but verified token by matching or
provisioning a fortymm account on its verified email.** When the verifier
(`FortymmAuth0TokenVerifier`) has a valid Auth0 token whose `sub` is not yet
linked, it reads the token's `email` / `email_verified` claims and:

1. **`sub` already linked** → the existing linked user (unchanged from #4).
2. **`sub` unlinked, `email` present and `email_verified` true:**
   - **an existing live account holds that `email`** (case-insensitive) → bind
     `auth0_sub` to it and return it (**match**);
   - **no account holds it** → create a *registered* account — coolname-slug
     username (**not** derived from the email; usernames are public), `email`
     set, `confirmed_at` stamped, `auth0_sub` bound, plus the same default role +
     default league every account gets — and return it (**provision**).
3. **no `email`, or `email_verified` false** → `None` (401). We never match or
   provision off an address the caller hasn't proven they control.

The `mcp.access` authorization check (#3/#5 of the prior ADR) runs unchanged on
whatever user comes back. A freshly provisioned account holds only the default
role, so during bring-up it 401s at that check until `mcp.access` is widened to
the default `User` role (a later, out-of-scope seed change); a matched
pre-existing Beta-tester account works immediately. So this ADR removes the
account/link friction now and becomes truly zero-step the moment `mcp.access`
moves to the default role.

Two trust/convergence points this rests on:

- **A verified Auth0 email is trusted as equivalent to fortymm's own magic-link
  inbox-proof.** Both establish only "the caller controls this inbox," which is
  exactly the bar fortymm's magic-link sign-in already sets — so a provisioned
  account is born `confirmed_at`-stamped rather than half-real, and matching an
  existing account carries no more takeover risk than a magic-link login to it
  would. This holds only for Auth0 connections whose `email_verified` is
  meaningful (a DB connection's verify-link, or a trusted social IdP); a
  connection that asserts `email_verified` without verifying must not be enabled.
- **The reverse-order convergence reuses existing merge machinery, not new
  code.** Magic-link-then-agent converges via the match step above;
  agent-then-magic-link converges because the email-confirm flow already sees the
  address is taken and folds the two accounts together (`account_merge`, which
  already move-or-nulls `auth0_sub` onto the survivor). `users.email` /
  `users.auth0_sub` uniqueness is the backstop for the near-simultaneous race
  (loser re-resolves). An explicit both-directions test guards this.

## Consequences

- **The MCP verifier now writes to the DB** (a bind, or an INSERT) on the first
  token for a new identity — where previously verification was pure. It is
  first-token-only per `sub`; every later token resolves the now-linked user with
  no write.
- **The write path is per-IP rate limited** (the match-bind / provision happens on
  an as-yet-unauthorized caller, before the `mcp.access` check). The steady-state
  linked-user read path is resolved first and is *not* limited, so a real agent is
  never throttled; only the first-token write is bounded per client IP so a stream
  of freshly-minted verified-email identities from one source can't spray accounts.
- **Dead until an Auth0 Action ships `email` + `email_verified` on the MCP access
  token.** Custom-API tokens carry no profile claims by default; without the
  Action every unlinked token hits step 3 and 401s. Auth0 drops non-namespaced
  custom claims, so the verifier reads them under the namespaced keys
  `https://fortymm.com/email` and `https://fortymm.com/email_verified`. The Action
  is Auth0-dashboard config — documented in `docs/auth0-mcp-email-claims-action.md`
  (the exact JS + install steps), but not automated here.
- **A user whose Auth0 login email differs from their existing fortymm email gets
  a second account** (we can't know they're the same person); they can merge later
  via magic-link. Accepted, not fixed.

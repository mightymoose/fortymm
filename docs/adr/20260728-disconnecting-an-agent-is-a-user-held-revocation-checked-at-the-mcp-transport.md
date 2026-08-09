# Disconnecting an agent is a user-held revocation checked at the MCP transport

Date: 2026-07-28 (date-numbered — sequential numbers collide across concurrent
worktrees; see the note in
`20260718-the-match-flow-is-shared-services-behind-http-and-mcp-adapters.md`)

## Status

Accepted.

**Amends** `20260722-the-mcp-server-is-an-oauth-resource-server-trusting-auth0.md`
(decision #3, "revoking `mcp.access` cuts an agent off immediately even while its
Auth0 token is still valid") by supplying the missing *user-held* half of that
promise: #3 describes an **operator** revoking a grant through RBAC admin, which
cannot express "this one player switched their own agent access off".

**Constrains** `20260722-mcp-accounts-auto-provision-and-match-by-verified-auth0-email.md`.
That ADR made verified-email matching the only onboarding path; this one carves
out the single case where matching must **not** bind.

## Context

The Claude access settings page needs a "Disconnect" control. The obvious
implementation — clear `users.auth0_sub` — is worse than doing nothing, because
it is silently self-undoing:

1. Disconnect sets `users.auth0_sub = NULL`.
2. The agent's Auth0 JWT is unaffected. It is a signed bearer token verified
   against JWKS (`app.mcp_server.FortymmAuth0TokenVerifier`); there is no
   introspection call and no denylist, so it stays valid until `exp`.
3. On the agent's very next request `resolve_linked_user` misses, falls through
   to the verified-email match in `app.auth0_provisioning.resolve_or_provision_user`,
   finds the same live account by email, and **re-binds the same `sub`**
   (`auth0_provisioning.py:88-95`).

So the connection re-establishes itself within seconds of being "removed", with
no user-visible signal. A settings page that says *"Claude stops being able to
read or change anything on your account, immediately"* on top of that mechanism
is making a false safety claim — precisely the class of claim the design's own
handoff notes flagged for engineering sign-off.

Two adjacent mechanisms were considered and rejected as the home for this bit:

- **RBAC.** `mcp.access` is granted role-wise (the Beta tester bundle), and the
  schema has `user_role` and `role_permission` but **no user→permission edge**.
  Revoking one player's access would mean stripping their whole Beta tester
  role, taking unrelated capabilities with it. Introducing a general per-user
  permission-override (deny) table would make every future permission check
  learn about denies — a large, general mechanism bought for one checkbox.
- **A refused-`sub` table.** Precise about the identity, but it models "this
  Auth0 identity is banned" rather than "this player turned agent access off",
  and it strands a player who reconnects with the same email.

## Decision

**Disconnecting is a user-held revocation, recorded on the user and enforced at
the MCP transport — not an unlinking.**

1. **A nullable `users.agent_access_revoked_at` timestamp** records that the
   player has switched agent access off. It is the player's own state, distinct
   from the operator's RBAC grant and from the `auth0_sub` binding.

2. **The MCP token verifier refuses a revoked user**, alongside the existing
   `mcp.access` permission check in `FortymmAuth0TokenVerifier.verify_token`.
   Enforcement sits at the transport, so it applies to all 28 tools at once and
   a new tool cannot forget it. Because it is checked *after* the token resolves
   to a user, it defeats the re-bind above: re-binding `auth0_sub` does not help
   a caller whose user is revoked. Revocation is therefore effective against
   already-issued, still-valid JWTs — the property decision #3 promised.

3. **Revocation blocks the auto-bind, and the binding is left in place.**
   `resolve_or_provision_user` must not match-and-bind onto a revoked account.
   Disconnect stamps `agent_access_revoked_at` and stops there — it does *not*
   clear `auth0_sub`.

   An earlier draft cleared the binding too, called "cosmetic: it makes the
   page's state honest". That was wrong on its own terms. `resolve_agent_access_state`
   ranks `revoked` above `connected`, so while the stamp is set the page reads
   `revoked` whether or not a `sub` is bound — the clear made nothing more
   honest, and it cost two things:

   - **A shared rate-limit bucket.** With no linked `sub`, every request from
     the agent's still-valid token missed the write-free `resolve_linked_user`
     path and fell into the provisioning path, spending a token from the per-IP
     limit before being refused. Claude.ai's connector egress IP is shared
     between players, so one disconnected player's polling agent could exhaust
     it and block strangers' first-ever bind. (That bucket is a
     Consequence of
     `20260722-mcp-accounts-auto-provision-and-match-by-verified-auth0-email`,
     not a decision here. It is now spent only immediately before a write —
     `resolve_or_provision_user` takes a `may_write` gate — so a refusal costs
     nothing and the limit prices writes rather than requests. That fixes the
     shared-bucket problem independently; leaving the binding alone keeps the
     request on the write-free hot path in the first place.)
   - **A misleading way back.** After a re-allow the page reported `ready` and
     walked the player through setup steps they did not need — the next token
     re-bound the same identity by verified email regardless.

   Leaving it bound makes re-allow mean what the dialog says: "switch Claude
   access back on" restores the connection rather than asking for it again.

4. **Reconnecting is an explicit user act.** Revocation is sticky — there is no
   timer and no implicit clear, or the disconnect would be a lie again. The
   settings page's ready state, when the account is revoked, leads with an
   "Allow Claude to connect" control that clears the timestamp. So the round
   trip is: connect (implicit, by signing in) → disconnect (explicit) →
   re-allow (explicit) → connect (implicit).

5. **Revocation is per-user, not per-connector.** The binding is one Auth0
   identity, so disconnecting stops *every* agent signed in with that email —
   Claude, Claude Code, anything else. The UI must say so on the destructive
   action rather than implying a Claude-only scope.

## Consequences

- The safety claim on the disconnect dialog becomes true, and is the only
  version of this feature where it is.
- Revocation survives token re-issue, account re-match, and replica round-robin,
  because it is a database fact checked per-request rather than token state.
- One extra indexed-column read on the MCP hot path, in the same session the
  permission check already opens. No additional round trip.
- A revoked player who follows the connector setup steps again gets a silent
  401 until they re-allow. The page must therefore never show the bare setup
  panel to a revoked account — the re-allow control is load-bearing, not
  decorative, and its absence would be a dead-end.
- Operator RBAC revocation (`mcp.access`) and player revocation are independent
  and both fail closed. Neither can re-grant the other.
- `account_merge` must carry the flag: merging a revoked account into another
  must not silently re-enable agent access.

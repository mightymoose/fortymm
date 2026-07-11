# 16. Every user holds the default `User` role, granted at mint

Date: 2026-07-11

## Status

Accepted

## Context

RBAC in fortymm is permission-based, not role-based: `require_permission(name)`
(`api/app/rbac.py`) joins `permissions → role_permissions → user_roles` and asks
whether *this user* holds *this permission name*. Roles exist only as a bundle of
permissions to hang off a user. `GET /v1/session` flattens the join and returns
permission **names** only — the client never sees a role.

Two facts about the current system shaped this decision:

1. **Nothing assigns anyone a role.** `api/scripts/seed_rbac.py` seeds
   `permissions`, `roles`, and `role_permissions` — but never `user_roles`. The
   only write to `user_roles` is `PUT /v1/users/{user_id}/roles`, itself gated on
   `authorization.manage`. The first `authorization.manage` holder must therefore
   be granted out-of-band, by hand, in SQL.

2. **There is no signup.** Identity is guest-first: a `users` row is minted on a
   visitor's first `GET /v1/session` (`_create_session`). Email confirmation
   (`POST /v1/me/email/confirm`) and magic-link sign-in (`POST /v1/login/consume`)
   *attach an email to an already-existing row* — they never create one. "The
   moment someone joins the site" and "the moment a `users` row is minted" are the
   same moment, and it happens before the visitor has done anything.

We want a lever: a single role that everyone holds, so that granting a capability
to the whole population is a one-row change in the admin UI (add the permission to
the role) rather than a migration or a code change.

## Decision

**Seed a role named `User`, carrying zero permissions, and grant it to every user
at the moment their row is minted.**

Five things this pins down.

### The grant is materialized, not virtual

Every user gets a real `user_roles` row. The rejected alternative was a *virtual*
default — leave `user_roles` alone and have the permission resolver always fold in
the default role's permissions for everyone. Virtual costs no hot-path write and
no backfill, but it makes the default role invisible in the admin Users page
(nobody is listed as holding it) and it special-cases the one resolver that every
authorization decision in the app flows through. A materialized row means there is
exactly one way a user comes to hold a permission, and `PUT /v1/users/{id}/roles`
keeps meaning what it says.

### Everyone means every visitor

The grant happens at guest-mint, so it reaches anonymous traffic — bots and
crawlers included. This is deliberate: it is the only reading of "everyone" that
holds, given that a user row exists before the human has identified themselves.
The consequence to keep in mind when *using* the lever: **any permission added to
`User` is granted to anonymous visitors**, not just to people who have confirmed
an email. A capability that must be reserved for claimed accounts does not belong
on this role.

Admin-created users (`POST /v1/users`) get it too — a user minted through the
admin door is still a user.

### It ships with zero permissions

`User` grants nothing on day one. It is a lever, not a capability. Because
`/v1/session` exposes permission names and this role adds none, the change is
invisible to the web client and to iOS: no session payload changes, no generated
types change, no UI changes.

### A missing seed row is a hard failure

`_create_session` looks the role up by name. If the row is absent — a fresh
database, or an app that serves traffic before the seed hook has run — session
creation **raises**, and every visitor gets a 500. We do not soft-skip.

A soft skip would trade a loud, immediate, obviously-wrong failure for a silent
one: users minted role-less during the window, invisible until months later when a
permission is hung off `User` and an arbitrary cohort mysteriously doesn't have
it. "The default role exists" is an invariant of a correctly-deployed system, and
the seed step already runs ahead of the API in every environment
(`docker-compose.dev.yml`, `docker-compose.qa.yml`, the UAT migrate-job Helm hook).
Breaking loudly is how that ordering stays true.

### The role is protected from deletion and rename

`DELETE /v1/roles/{id}` and `PATCH /v1/roles/{id}` refuse to remove the default
role or change its name — the name is the lookup key that guest-mint depends on,
and deleting the role would silently strip it from every user via the `ON DELETE
CASCADE` on `user_roles`. This mirrors the existing guard that stops an admin
deleting the last `authorization.manage` holder (themselves).

Its **permissions** stay freely editable. That is the entire point of the role.

### Per-user membership is protected too

The delete/rename guards defend the role's *existence*, but the per-user role
editor (`PUT /v1/users/{id}/roles`, a full replace) could still strip `User`
from one account at a time — quietly breaking the "everyone holds it" invariant
for that user, and silently excluding them from any capability later hung off the
role. So the assignment endpoint **always retains the default role**: whatever set
of role ids it is handed, the default role's membership survives. The admin Users
editor disables that one checkbox up front (as the Roles page disables Delete),
and the endpoint enforces it as the backstop. Every *other* role remains freely
assignable and removable.

To make the role legible rather than merely protected, the role read payload
carries an `is_default` flag **derived from the name** — not stored. A boolean
column would be a second source of truth for a fact the name already settles, and
it would need its own "exactly one default role" invariant to police. Deriving it
means the admin Roles page can badge the role and disable its Delete control
proactively (the precedent set by the self-delete guard on the Users page) with
nothing new to keep in sync.

## Consequences

- Granting a capability to the whole population is now an admin-UI action: add the
  permission to `User`. No code, no migration.
- The name `User` becomes load-bearing. It lives in exactly one constant, shared
  by the seed script, the guest-mint grant, and the delete/rename guard.
- Session creation gains one INSERT on the hot path. It is on the write path that
  already inserts a `users` row and a `user_tokens` row, so it does not add a
  round-trip class that wasn't there.
- Account merge already re-points `user_roles` with a `NOT EXISTS` de-dupe, so a
  merge where both sides hold `User` collapses cleanly to one row. That behaviour
  is now exercised by every merge rather than by none.
- Existing user rows are backfilled once. Per the project's pre-deploy convention
  the data is disposable, but the backfill means a developer's existing local
  database doesn't quietly hold a population of role-less users.

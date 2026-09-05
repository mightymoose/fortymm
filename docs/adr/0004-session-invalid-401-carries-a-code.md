# A session-invalid 401 carries a structured code that ends the session

The passive-reload exception below is superseded by
[explicit identity recovery for #1641](20260904-session-eviction-requires-explicit-identity-recovery.md).
The structured error-code decision remains in force.

When the session cookie no longer resolves to a usable user, `get_current_user`
raises a `401` carrying a **structured `session_ended` code** (mirroring the
existing `session_merged` code for a tombstoned/merged cookie). The web client
matches on that **code**, not the bare `401` status: on either code it treats the
tab as **session-ended** — drops the cached `['session']` identity and redirects
to `/login`, clearing the dead cookie — and never lets the next bootstrap quietly
mint a fresh guest in the signed-out user's place.

Keying off an explicit code — rather than "any plain 401" — kills a
false-positive class **by construction**: only a genuinely invalid session
carries the code, so no future 401 added elsewhere (a bad token, a failed
captcha, a permission check) can ever trip the global sign-out. Today those
already return `400`/`409`, so a bare-status rule would be safe *now*; the code
makes it safe *permanently* and is symmetric with the pattern already in place.
The `session_ended` code lives on the single dependency every authenticated
endpoint funnels through (`sessions.py` `get_current_user`), so one server site
covers every write. (The 401 `detail` is an `HTTPException` payload, not part of
any `response_model`, so it does not appear in `openapi.json` — no generated-type
drift, same as `session_merged`.)

## Bug context

Fixes D4. A claimed user with an unsaved game score in tab 1 signs out from
tab 2. Tab 1 still shows the stale identity. Clicking "Save game & next" fires
the score write **fire-and-forget and navigates synchronously in the same
gesture** (deliberate, to keep the mobile keyboard open — #567), so the
cookieless write's 401 lands *after* navigation and was previously swallowed:
the deciding game vanished with no error, and a later reload minted a brand-new
guest. Routing the `session_ended` 401 through the existing session-ended
handler turns that silent data loss into an honest "you've been signed out —
sign back in."

## Considered options

- **Structured `session_ended` code, client matches on the code (chosen).** One
  server site, symmetric with `session_merged`, robust against any future 401 by
  construction. Catches the save mutation *and* the destination page's query at
  the shared HTTP boundary, and pre-empts the reload-guest by moving the user to
  `/login` before they'd reload into a fresh guest. Keeps the #567 optimistic
  navigate intact.

- **Client matches on the bare plain-401 status (rejected).** Client-only and
  safe today (the only two 401 sites in the API are both session-invalid), but
  fragile: the day anyone adds a third 401, the global sign-out misfires
  mid-flow (e.g. nuking a guest session during a merge). The one-line server
  code removes that latent trap.

- **Await-then-navigate on the score write (rejected).** Surfacing the failure
  inline would mean the save awaits its response before navigating, regressing
  the #567 keyboard behavior on every save, not just the rare signed-out one.

- **A durable "this browser held a claimed account" marker (originally rejected;
  passive-reload exception superseded by #1641).** Would
  additionally kill the silently-minted guest on a *passive reload* (where no
  request 401s, so the reactive handler can't fire). Rejected as fragile: the
  marker's clearing rule trades a redirect-loop risk against a silent-guest
  window, and the passive-reload case is cosmetic — the participant guard
  (`score-entry.tsx`) already bounces the fresh guest off the scoring surface to
  read-only match details, so no score can be entered on a match the caller is
  not a participant in and no data is lost. We accept a guest being minted on
  passive reload; we do not accept silent score loss or acting on a dead session.

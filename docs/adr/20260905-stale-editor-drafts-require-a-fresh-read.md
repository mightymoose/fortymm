# Stale editor drafts require a fresh read

Accepted for #1526, #1403, and #1217.

A stale save must not overwrite another director's saved work. Reject the whole
save, preserve the draft, and offer **Load latest**. Loading replaces the entire
form, including its saved version; confirm before discarding unsaved edits.
There is no overwrite or automatic merge action.

Tournament Details (name, description, and venue) share `details_version`.
Any PATCH carrying one of these fields must send the version originally read;
a missing or stale version returns a coded 409
(`tournament_details_version_conflict`) without writing anything. The version
advances on every accepted Details save, even if values are unchanged. Table
catalogue-only changes and event edits do not advance it. A request combining
Details and tables is atomic and must satisfy the Details precondition.

Each event retains its independent `lock_version`; its reservations share that
version. The historical table-pool editor in #1403 is now the event's reservation
editor. Editing one event must not invalidate another event or a Details draft.

The shared edit verb enforces the Details precondition for HTTP and MCP callers.
A preliminary read rejects already-stale drafts before geocoding, and the
comparison is repeated under the existing tournament row lock before applying
any fields. External geocoding stays outside that lock.

Background refreshes preserve dirty drafts and show **Updated elsewhere** when
a newer version arrives. Save remains available and sends the original version;
the server remains authoritative even when the browser has not seen the change.
Successful saves and rejected saves reconcile the page's current data. Loading
latest is a local draft replacement, not a write. Another intervening save may
cause a new conflict; it never silently upgrades a draft's version.

The database column is added to the original tournament migration, following the
repository's pre-deployment migration policy. Existing databases need their
normal fresh-schema setup before running this branch.

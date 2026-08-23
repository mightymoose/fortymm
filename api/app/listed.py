"""WHO MAY BE LISTED AS A PLAYER — the one predicate behind every public listing.

``POST /v1/login/request`` mints a ``users`` row whenever the submitted address
matches no account (#1292), and an abandoned login-token consume leaves such a
row behind too. Nobody can ever browse either kind of row: the mint issues no
session token, and a failed/expired consume is unreachable. A public listing
that showed those rows would answer "does this address have an account?" to
anyone who diffs the roster around a login request — the enumeration channel
#1292's constraint forbids answering, closed here by never listing a row that
no person has visited (#1438).

The rule is one column: ``users.last_seen_at IS NOT NULL``. The auth resolver
(``app.sessions._resolve_current_user``) stamps it when a session cookie
resolves an existing user; ``GET /v1/session`` does NOT stamp the guest it
mints, so a drive-by bootstrap call stays unlisted until that visitor actually
browses.

ONE PREDICATE, ONE ROSTER (the ``is_rated_member`` precedent): the roster body,
the roster's ``total``, opponent search, recent opponents and head-to-head
rivals all filter through this function, so no two of them can disagree about
who is listed — a count carrying a different population than its body rebuilds
the oracle on its own.

It is deliberately ONE conjunct. The tombstone check
(``merged_into_user_id IS NULL``) stays spelled out beside each call site,
because three by-id lookups (``app.players._load_player_by_id``,
``app.tournament_entries``, ``app.match_creation``) must keep excluding ghosts
WITHOUT delisting: folding both checks into this helper would leave the by-id
sites spelling the tombstone condition themselves — two spellings of one rule,
the drift this module exists to prevent. So: a guest whose profile 404s for
everyone but still enters draws and matches is impossible; a guest who shows up
in a roster without ever having browsed is equally so.
"""

from sqlalchemy import ColumnElement

from app.models import User


def is_listed_player() -> ColumnElement[bool]:
    """A ``User`` row that may appear in a public player listing: someone has
    browsed the account at least once (``last_seen_at IS NOT NULL``).

    Drop into any ``User``-rooted query's WHERE clause. Deliberately not
    applied to by-id lookups — reachability is not enumerability, and a
    never-active guest's own profile, tournament entry and match creation must
    keep working.
    """
    return User.last_seen_at.is_not(None)

"""Shared Player listing predicate.

Only a Player seen through an active session is publicly listed. This preserves
email-account enumeration protection: login requests provision identities but do
not publish their Players. Session resolution stamps the primary Player; a new
guest bootstrap alone does not. Unclaimed Players remain accessible by ID for
backend-managed participation without creating a new public listing workflow.

Player tombstone exclusion remains separate so by-ID queries can reject retired
Players without requiring public listing eligibility.
"""

from sqlalchemy import ColumnElement

from app.models import Player


def is_listed_player() -> ColumnElement[bool]:
    """A ``Player`` row that may appear in a public player listing: someone has
    browsed the account at least once (``last_seen_at IS NOT NULL``).

    Drop into any ``Player``-rooted query's WHERE clause. Deliberately not
    applied to by-id lookups — reachability is not enumerability, and a
    never-active guest's own profile, tournament entry and match creation must
    keep working.
    """
    return Player.last_seen_at.is_not(None)

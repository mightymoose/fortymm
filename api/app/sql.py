"""Pure SQL text helpers, shared by every module that builds a query.

Deliberately framework-free — no FastAPI, no routers, not even a session — so the
bottom of the query stack (``app.match_queries``, the repositories) can import it
without transitively constructing a router and its route table.
"""

from __future__ import annotations


def escape_like(term: str) -> str:
    """Escape LIKE wildcards so a query of ``%`` matches a literal percent
    sign rather than every username."""
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

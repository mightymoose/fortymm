"""The result-acceptance push/in-app notification cluster.

Extracted out of the ``app.matches`` router so both the HTTP handler
(``post_match_result``) and the MCP ``propose_result`` tool can queue the
"accept or suggest a correction to the result your opponent posted" prompt
without one adapter importing the other's router internals (``api/CLAUDE.md`` —
"don't import another router's internals").

FastAPI-free: it imports only domain/query/serializer/notification modules —
never a router — so it stays cycle-free and is drivable outside an HTTP request.
"""

import uuid

from app.match_queries import my_side, opponent_side
from app.match_serialization import negotiation
from app.models import Match
from app.notifications.apns import MATCH_RESULT_CONFIRMATION_CATEGORY
from app.notifications.service import NotificationService
from app.notifications.taxonomy import NotificationCategory
from app.result_acceptance import side_win_counts
from app.result_chain import standing_result
from app.schemas.notification import NotificationJob

# En-dash between scores reads better than a hyphen in notification copy.
_SCORE_DASH = "–"


def _game_scores_text(match: Match, poster_side_number: int) -> str:
    """Compact per-game scores oriented poster-first (e.g. ``"11–7, 9–11"``),
    so they line up with the games-won headline the recipient sees. Games with
    no saved score are skipped."""
    parts: list[str] = []
    for game in sorted(match.games, key=lambda g: g.game_number):
        if game.score is None:
            continue
        if poster_side_number == 1:
            poster_pts, recipient_pts = (
                game.score.side_1_points,
                game.score.side_2_points,
            )
        else:
            poster_pts, recipient_pts = (
                game.score.side_2_points,
                game.score.side_1_points,
            )
        parts.append(f"{poster_pts}{_SCORE_DASH}{recipient_pts}")
    return ", ".join(parts)


def _result_confirmation_copy(
    match: Match, poster_id: uuid.UUID, *, is_counter: bool
) -> tuple[str, str] | None:
    """Title + body for the "accept or suggest a correction to the result your
    opponent posted" push, framed for the *recipient* (the side that didn't
    post).

    ``is_counter`` picks the closing prompt to match the actual button pair
    the recipient's in-app callout renders: a first-post shows Accept /
    Suggest correction (``confirmation-callout-display.tsx``'s ``"review"``
    case), while a counter shows Accept / Counter (its ``"corrected"`` case,
    #728). The native iOS push notification itself only ever offers a single,
    static Approve/Suggest-correction action pair (``PushNotificationManager
    .swift``) — it doesn't yet grow a counter-specific action — so this body
    text is the only place a tapped-through counter reads "Counter" until the
    push actions themselves are split the same way.

    The headline carries the games-won score and, where there's room, the
    body lists the individual game scores — both oriented so the poster's
    number comes first. Returns ``None`` when the match isn't a two-human
    match (nothing to accept)."""
    poster_side = my_side(match, poster_id)
    recipient_side = opponent_side(match, poster_id)
    if poster_side is None or recipient_side is None or not poster_side.players:
        return None

    poster_name = poster_side.players[0].user.username
    wins = side_win_counts(match)
    poster_games = wins.get(poster_side.side_number, 0)
    recipient_games = wins.get(recipient_side.side_number, 0)

    # Score always reads winner-first; the phrase tells the recipient which
    # side the poster claims won.
    if poster_games >= recipient_games:
        phrase, hi, lo = "beating you", poster_games, recipient_games
    else:
        phrase, hi, lo = "losing to you", recipient_games, poster_games
    headline = f"{poster_name} reported {phrase} {hi}{_SCORE_DASH}{lo}"

    prompt = "Accept or counter?" if is_counter else "Accept or suggest a correction?"
    games = _game_scores_text(match, poster_side.side_number)
    body = f"{headline}. Games: {games}. {prompt}" if games else f"{headline}. {prompt}"
    return "Accept your match result", body


def _result_accepted_copy(match: Match, poster_id: uuid.UUID) -> tuple[str, str] | None:
    """Title + body for the "your reported result was accepted" notice, framed
    for the *poster* (the side that proposed the now-final result).

    Names the accepting opponent and lists the per-game scores oriented
    poster-first (so they read the same way the poster entered them). Returns
    ``None`` when the opposing side isn't a real player (a solo / player-less
    sentinel side — nothing could have accepted)."""
    poster_side = my_side(match, poster_id)
    acceptor_side = opponent_side(match, poster_id)
    if poster_side is None or acceptor_side is None or not acceptor_side.players:
        return None

    acceptor_name = acceptor_side.players[0].user.username
    games = _game_scores_text(match, poster_side.side_number)
    headline = f"{acceptor_name} accepted your reported result"
    body = (
        f"{headline}. Final score {games}. It's now official."
        if games
        else f"{headline}. It's now official."
    )
    return "Your result was accepted", body


async def notify_result_accepted(
    notifications: NotificationService, match: Match, poster_id: uuid.UUID
) -> None:
    """Tell the poster (the side that proposed the standing result) that their
    result was accepted and the match is now final — closing the loop the
    propose-side prompt opened.

    The mirror of :func:`notify_result_posted`: propose notifies the side that
    *owes* a response; accept notifies the side that was *waiting* on one. Filed
    under the same ``RESULT_CONFIRM`` family and enqueued once per player on the
    poster's side. Unlike the propose prompt it carries **no** APNs action group
    or ``push_category`` — the match is finalized, there is nothing left to
    accept or counter — so it fans out as a plain in-app + push/email notice,
    matching the retirement notices in ``app.retirement_jobs``. A per-match
    ``collapse_id`` (distinct from the propose prompt's) replaces any stale
    accepted-notice on the lock screen. Returns without enqueuing when the
    poster's side can't be resolved to a real player (a solo / player-less
    sentinel side)."""
    poster_side = my_side(match, poster_id)
    if poster_side is None or not poster_side.players:
        return
    copy = _result_accepted_copy(match, poster_id)
    if copy is None:
        return
    title, body = copy
    for player in poster_side.players:
        notifications.enqueue_notification(
            NotificationJob(
                user_id=player.user_id,
                category=NotificationCategory.RESULT_CONFIRM,
                title=title,
                body=body,
                link=f"/matches/{match.id}",
                action_label="View result",
                collapse_id=f"result-accepted:{match.id}",
            )
        )


async def notify_result_posted(
    notifications: NotificationService, match: Match, poster_id: uuid.UUID
) -> None:
    """Queue an accept/counter (or accept/suggest-correction) prompt to every
    player on the side that now owes a response. Each enqueued job persists
    the in-app record (the bell feed) and fans out push/email per the
    recipient's preferences in the worker. The APNs ``category``/``data``
    carry the action group, the match id (so a tapped push deep-links to the
    right match), and the standing result id (so a tapped Approve binds to the
    exact result the push described, not whatever is standing at tap time — see
    docs/adr/0007), plus a per-match ``collapse_id`` so a superseding push
    replaces the stale one on the lock screen."""
    recipient_side = opponent_side(match, poster_id)
    if recipient_side is None or not recipient_side.players:
        return
    # Derive counter-vs-first-post from the same viewer-relative negotiation
    # state the BFF/UI use (``negotiation``'s ``"corrected"`` vs ``"review"``),
    # rather than the raw ``supersedes_result_id is not None`` check — that
    # naive check is wrong on a self-edit (poster corrects their own standing
    # proposal before the recipient ever answers): it supersedes a result, but
    # the recipient still lands on the first-post "review" view, not
    # "corrected", so they must get the Accept/Suggest-correction prompt, not
    # Accept/Counter.
    is_counter = (
        negotiation(match, recipient_side.players[0].user_id).viewer_state
        == "corrected"
    )
    copy = _result_confirmation_copy(match, poster_id, is_counter=is_counter)
    if copy is None:
        return
    title, body = copy
    result = standing_result(match)
    push_data = {"match_id": str(match.id)}
    if result is not None:
        push_data["result_id"] = str(result.id)
    for player in recipient_side.players:
        notifications.enqueue_notification(
            NotificationJob(
                user_id=player.user_id,
                category=NotificationCategory.RESULT_CONFIRM,
                title=title,
                body=body,
                link=f"/matches/{match.id}",
                action_label="Review",
                push_category=MATCH_RESULT_CONFIRMATION_CATEGORY,
                push_data=push_data,
                collapse_id=f"result-confirm:{match.id}",
            )
        )

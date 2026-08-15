"""Minting an event's stages from its draw type, and re-applying the template in place
on a draw-type change (ADR 20260815 decisions 1, 3, 4).

**The template.** :func:`stage_template` is the whole of decision 3, in code rather than
a column: ``round_robin`` and ``single_elim`` and ``swiss`` are each their own
one-stage template, and ``rr_then_ko`` is the one composite — a pool stage feeding a
knockout stage. An exhaustive ``match`` with no catch-all, exactly like
``app.draws.strategy_for`` — a new :class:`~app.models.tournament.DrawType` member has
to declare its own template before this type-checks.

**The mint.** :func:`mint_stages` builds fresh rows from that template, positioned
0..N-1. It is what ``app.tournament_events.create_event`` passes as
``TournamentEvent(..., stages=mint_stages(...))`` — every event holds its minted stages
from the moment it exists, in the same transaction, because the stages are a
constructor argument, not a follow-up write.

**The re-mint.** :func:`remint_stages_in_place` is decision 3's "on a draw-type change
while no draw exists, the template is re-applied in place": position 0 (the ADR's
"stage 1") keeps its row identity and only its ``draw_type`` moves; later positions are
added or removed to match the new template's length. That is what lets anything hung off
stage 0 — a director's pools today — survive a type change. It is a **total** function:
an event with no stage rows at all (a row seeded straight through the ORM, bypassing
``create_event`` — the direct-to-database seam several sibling test helpers already use
for other tables) mints the whole template fresh rather than indexing into an empty
list.

**The freeze.** Neither function is the freeze itself — that is
``app.tournament_events._enforce_draw_settings_frozen``, which already refuses a
draw-configuration change on an event with a cut draw before anything is written.
:func:`remint_stages_in_place` is only ever called from the one seam past that guard
(``app.tournament_events.update_event``), and it is called there under one more gate of
its own: only when the event still has no draw. That second gate is what protects the
one case the freeze's own early return does not cover — a PATCH that resends the
event's *current* draw settings unchanged, which the freeze waves through (nothing
moved) even when a draw already exists. Without the extra gate a re-mint would still run
there and rewrite stage rows a draw has already been cut across.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DrawType, TournamentEvent, TournamentEventStage


def stage_template(draw_type: DrawType) -> tuple[DrawType, ...]:
    """The stage sequence ``draw_type`` mints (ADR 20260815 decision 3).

    Exhaustive over :class:`DrawType`, no catch-all: a fifth draw type is a ``mypy``
    error here until this function says what it mints, the same shape
    ``app.draws.strategy_for`` and ``app.draws.reads_fixture_games`` already use for the
    same enum.

    Only ``rr_then_ko`` mints more than one stage. None of the four branches ever
    returns ``DrawType.rr_then_ko`` as a *component* — decision 4's "there is no
    stage-runnable flag; the code refuses rr_then_ko as a stage's type at the
    boundary" — and :attr:`TournamentEventStage.draw_type`'s setter is the boundary
    that would refuse it if a future branch ever tried.
    """
    match draw_type:
        case DrawType.round_robin:
            return (DrawType.round_robin,)
        case DrawType.single_elim:
            return (DrawType.single_elim,)
        case DrawType.swiss:
            return (DrawType.swiss,)
        case DrawType.rr_then_ko:
            return (DrawType.round_robin, DrawType.single_elim)


def mint_stages(draw_type: DrawType) -> list[TournamentEventStage]:
    """Fresh, unattached stage rows for ``draw_type``'s template, positioned 0..N-1.

    What ``app.tournament_events.create_event`` passes straight into
    ``TournamentEvent(..., stages=...)`` — the rows carry no ``event_id`` yet, and never
    need one set here: SQLAlchemy fills it in from the parent at flush, the same way
    ``app.tournament_pools.stored_pools`` already works for a brand-new event's pools.
    """
    return [
        TournamentEventStage(position=position, draw_type=component)
        for position, component in enumerate(stage_template(draw_type))
    ]


async def remint_stages_in_place(
    db: AsyncSession, event: TournamentEvent, draw_type: DrawType
) -> None:
    """Re-apply ``draw_type``'s template onto ``event``'s stages IN PLACE.

    Reads the current rows through an explicit query — **never** through
    ``TournamentEvent.stages`` (that relationship is deliberately not eager; see its
    docstring), so this never risks an async lazy load.

    Stage 0 keeps its row identity: its ``draw_type`` is written whether or not it
    actually changes, which is exactly the ADR's "stage 1 keeps its identity and its
    draw type is updated". Trailing positions are appended when the new template is
    longer, or deleted from the tail when it is shorter. Positions never move, so
    nothing here ever needs the deferrable-constraint trick the pool/table position
    columns use for a re-order — a stage re-mint is never a re-order.

    Does not commit or flush; the caller's transaction owns that (mirrors
    ``store_draw_settings``, the sibling write this always runs beside).
    """
    template = stage_template(draw_type)
    existing = (
        (
            await db.execute(
                select(TournamentEventStage)
                .where(TournamentEventStage.event_id == event.id)
                .order_by(TournamentEventStage.position)
            )
        )
        .scalars()
        .all()
    )
    if not existing:
        # Total, not partial: an event a test seeded straight through the ORM (bypassing
        # ``create_event``, so it never got a mint) has nothing to re-mint IN PLACE —
        # there is no stage-0 identity to preserve, so this mints the template fresh.
        for position, component in enumerate(template):
            db.add(
                TournamentEventStage(
                    event_id=event.id, position=position, draw_type=component
                )
            )
        return
    existing[0].draw_type = template[0]
    if len(template) > len(existing):
        for position in range(len(existing), len(template)):
            db.add(
                TournamentEventStage(
                    event_id=event.id, position=position, draw_type=template[position]
                )
            )
    elif len(template) < len(existing):
        for stale in existing[len(template) :]:
            await db.delete(stale)

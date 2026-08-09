"""The **eight inputs, assembled once** on the server side (#1320): the bridge between
an event as a write would leave it and :func:`app.draw_structure.derive_draw_structure`,
which takes eight loose numbers and modes.

The twin of the client's ``event-draw-structure.ts``, and it exists for the same reason:
two callers — ``create_event`` and ``update_event`` — need the same answer about the
same event, and assembled twice the two would eventually disagree about which pool list
or which field size they meant.

It answers **one** question, ``is this configuration playable``, and it answers it about
the state the request would produce rather than the fields the request carries (ADR
``20260808-draw-structure-derivation-runs-on-both-sides-and-shares-its-vectors``). That
is what lets the director in #1320 escape: their event is already impossible, and one
request that changes the pool count and the qualifiers together has to be accepted.

Pure, and a leaf: it takes the parsed write arm, a pool-row count and a player cap, and
imports no session, no FastAPI and no ORM.
"""

from app.draw_structure import (
    DrawStructureOptions,
    ImpossibleProblem,
    SettingOwnership,
    derive_draw_structure,
)
from app.schedule_preview import DEFAULT_UNCAPPED_FIELD
from app.schemas.tournament import (
    DrawSettingsWriteArm,
    RrThenKoDrawSettingsWrite,
    StructuralSettingOwner,
)

__all__ = ["impossible_draw_structure", "preview_field_size"]


def preview_field_size(max_players: int | None) -> int:
    """The field the derivation runs against: the event's cap, or
    :data:`~app.schedule_preview.DEFAULT_UNCAPPED_FIELD` when it has none.

    The **same** number the schedule preview invents for an uncapped event
    (``schedule_preview._field_size``) and the same one the client's
    ``previewFieldSize`` labels its basis with, imported rather than restated so the
    three cannot drift. A director configures an event before registration opens, so
    there is no real field to judge — the refusals below are about the competition the
    numbers describe, not about anybody who has entered.
    """
    if max_players is not None:
        return max_players
    return DEFAULT_UNCAPPED_FIELD


def _ownership(owner: StructuralSettingOwner) -> SettingOwnership:
    """The wire's ownership enum as the derivation's.

    Two enums for one idea, on purpose: the derivation is a leaf that knows nothing
    about request schemas, and the schema's member is what crosses into the generated
    clients. An exhaustive ``match`` with no catch-all, so a third kind of owner is a
    type error here rather than a silent fallback (api/CLAUDE.md).
    """
    match owner:
        case StructuralSettingOwner.automatic:
            return SettingOwnership.automatic
        case StructuralSettingOwner.manual:
            return SettingOwnership.manual


def impossible_draw_structure(
    *,
    draw_settings: DrawSettingsWriteArm,
    pool_count: int,
    max_players: int | None,
) -> ImpossibleProblem | None:
    """The competition this event **could not play**, or ``None``.

    ``pool_count`` is the number of pool **rows** the write would leave the event with,
    not a stored count — an event's pool count is its pool rows (ADR
    ``20260808-an-events-pool-count-is-its-pool-rows-and-a-derived-count-is-a-
    projection``), and the pools ride on the same request as the configuration, so the
    caller counts the pools the request would leave rather than the ones on the row.

    Three deliberate narrowings, each of which is why this lives here rather than at the
    two call sites:

    * **``rr-then-ko`` only.** No other draw type has a pool stage feeding a knockout,
      so no other draw type can be refused for the shape of one. Round robin, single
      elimination and swiss are returned ``None`` without deriving anything.
    * **``impossible_problems`` only.** A **disagreement** is not a refusal: six pools
      of five seat thirty, a field of forty does not fit, and both numbers were typed on
      purpose, so the event saves (ADR ``20260808-a-structural-setting-is-owned-by-the-
      director-or-derived-by-the-system``). Only the *cut* is unavailable.
    * **At most one problem**, which is the derivation's own rule — one impossible
      competition is one thing to fix.

    The event's stored ``qualifiers_per_pool`` is passed as the *manual* qualifier
    number unconditionally, exactly as the client passes it: there is no second field
    for it, and ``qualifiers_mode`` is what decides whether anybody reads it.
    """
    if not isinstance(draw_settings, RrThenKoDrawSettingsWrite):
        return None
    structure = draw_settings.draw_structure
    derived = derive_draw_structure(
        DrawStructureOptions(
            preview_field_size=preview_field_size(max_players),
            pool_reservation_count=pool_count,
            pool_count_mode=_ownership(structure.pool_count_mode),
            manual_pool_count=structure.manual_pool_count,
            pool_size_mode=_ownership(structure.pool_size_mode),
            manual_pool_size=structure.manual_pool_size,
            qualifiers_mode=_ownership(structure.qualifiers_mode),
            manual_qualifiers=draw_settings.qualifiers_per_pool,
        )
    )
    if not derived.is_impossible:
        return None
    # Guarded by the line above, so this is not an index into a possibly-empty tuple:
    # ``is_impossible`` IS "there is a problem", and the derivation reports at most one.
    return derived.impossible_problems[0]

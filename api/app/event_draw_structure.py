"""The **eight inputs, assembled once** on the server side (#1320): the bridge between
an event as a write would leave it and :func:`app.draw_structure.derive_draw_structure`,
which takes eight loose numbers and modes.

The twin of the client's ``event-draw-structure.ts``, and it exists for the same reason:
two callers — ``create_event`` and ``update_event`` — need the same answer about the
same event, and assembled twice the two would eventually disagree about which pool list
or which field size they meant.

It answers **two** questions — ``is this configuration playable`` (the write's, chore
4b) and ``does this configuration leave entrants with nowhere to go`` (the cut's, chore
5c) — and it answers both about the state the caller is judging rather than the
fields a request carries (ADR
``20260808-draw-structure-derivation-runs-on-both-sides-and-shares-its-vectors``). That
is what lets the director in #1320 escape: their event is already impossible, and one
request that changes the pool count and the qualifiers together has to be accepted.

**The two questions are asked against two different fields, on purpose.** See
:func:`preview_field_size` and :func:`entrants_with_nowhere_to_go` — the assembly of the
eight inputs is shared (:func:`_derived`), and the field is the one input that differs.

Pure, and a leaf: it takes the parsed settings arm, a pool-row count and a field, and
imports no session, no FastAPI and no ORM. :data:`DEFAULT_UNCAPPED_FIELD` lives here
rather than in :mod:`app.schedule_preview` (which re-exports it, so every existing
reference to ``schedule_preview.DEFAULT_UNCAPPED_FIELD`` still resolves) for exactly
that reason: the preview imports :mod:`app.tournament_draws`, and the cut needs this
module, so a constant borrowed the other way round would close an import cycle.
"""

from app.draw_structure import (
    DisagreementDirection,
    DrawStructure,
    DrawStructureDisagreement,
    DrawStructureOptions,
    ImpossibleProblem,
    SettingOwnership,
    derive_draw_structure,
)
from app.schemas.tournament import (
    DrawSettingsWriteArm,
    RrThenKoDrawSettingsWrite,
    StructuralSettingOwner,
)

__all__ = [
    "DEFAULT_UNCAPPED_FIELD",
    "entrants_with_nowhere_to_go",
    "impossible_draw_structure",
    "preview_field_size",
]

#: The synthetic field size for an *uncapped* event (``max_players IS NULL``,
#: ADR-0935). An uncapped event has no natural number to auto-fill to, so a
#: configuration-time derivation needs a stand-in; the schedule preview's caller may
#: always override it. Sixteen is a plausible club-night field the ADR names as the
#: default. Re-exported by :mod:`app.schedule_preview`, which invents that many
#: entrants for its snapshot.
DEFAULT_UNCAPPED_FIELD = 16


def preview_field_size(max_players: int | None) -> int:
    """The field a **configuration-time** derivation runs against: the event's cap, or
    :data:`DEFAULT_UNCAPPED_FIELD` when it has none.

    The **same** number the schedule preview invents for an uncapped event
    (``schedule_preview._field_size``) and the same one the client's
    ``previewFieldSize`` labels its basis with, shared rather than restated so the three
    cannot drift. A director configures an event before registration opens, so there is
    no real field to judge — the write's refusals are about the competition the numbers
    describe, not about anybody who has entered.

    **The cut does not use this.** By then the entrants exist, and
    :func:`entrants_with_nowhere_to_go` judges them instead.
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


def _derived(
    draw_settings: DrawSettingsWriteArm, *, pool_count: int, field_size: int
) -> DrawStructure | None:
    """This configuration's whole derived structure, or ``None`` when the draw type has
    no pool stage feeding a knockout.

    **The eight inputs, assembled once** — the module's whole reason for existing. The
    write asks it about a preview field and the cut asks it about a real one, and two
    assemblies would eventually disagree about which pool list or which ownership mode
    they meant.

    The event's stored ``qualifiers_per_pool`` is passed as the *manual* qualifier
    number unconditionally, exactly as the client passes it: there is no second field
    for it, and ``qualifiers_mode`` is what decides whether anybody reads it.
    """
    if not isinstance(draw_settings, RrThenKoDrawSettingsWrite):
        return None
    structure = draw_settings.draw_structure
    return derive_draw_structure(
        DrawStructureOptions(
            preview_field_size=field_size,
            pool_reservation_count=pool_count,
            pool_count_mode=_ownership(structure.pool_count_mode),
            manual_pool_count=structure.manual_pool_count,
            pool_size_mode=_ownership(structure.pool_size_mode),
            manual_pool_size=structure.manual_pool_size,
            qualifiers_mode=_ownership(structure.qualifiers_mode),
            manual_qualifiers=draw_settings.qualifiers_per_pool,
        )
    )


def entrants_with_nowhere_to_go(
    *,
    draw_settings: DrawSettingsWriteArm,
    pool_count: int,
    field_size: int,
) -> DrawStructureDisagreement | None:
    """The disagreement by which this configuration seats **fewer** players than
    ``field_size``, or ``None``.

    The cut's question, and the reason a cut is refused where a save is not: a
    disagreement is two numbers the director typed on purpose, so the app keeps both and
    the event saves (ADR ``20260808-a-structural-setting-is-owned-by-the-director-or-
    derived-by-the-system``, "A disagreement is not a refusal"). A *cut* has to seat
    every entrant somewhere, so it would have to answer a question the director has not
    settled.

    **Only the ``unseated`` direction. Empty seats are answered ``None``, and that
    asymmetry is deliberate — do not tidy it into symmetry.** Seven pools of six against
    a real field of forty deals ``6,6,6,6,6,6,4``: an uneven split, which this app calls
    legal and previews as legal. Refusing it would also close the last door on the
    director, because the reference's own resolution for a disagreement —
    ``Use ceil(field / size) pools of {size}``, labelled "Everyone gets a seat." —
    rounds **up**, so applying the fix the app itself offers lands on seats to spare
    every time the size does not divide the field.

    **``field_size`` is the real registered field, and the caller passes it — this is
    not :func:`preview_field_size`.** Three reasons, in the order they decide it:

    * The ADR's disagreement is about the cut having to invent an answer. What the cut
      actually deals is the event's active entrants, so that is the only field whose
      arithmetic can force an invention. A cap is a limit nobody may have reached, and
      the uncapped default is a number nobody has entered.
    * Judged against the preview field the guard would get both cases backwards: it
      would refuse a structure that seats the real field exactly (six pools of five
      against thirty entrants deals exactly the pools the director asked for), and wave
      through one that does not.
    * A refusal quotes numbers a director has to be able to check. At cut time the
      entrant list is on screen; the preview field is not.

    ``pool_count`` is the number of pool **rows** the event has, and it is read only
    when the pool count is *automatic* — an event's pool count is its pool rows (ADR
    ``20260808-an-events-pool-count-is-its-pool-rows-and-a-derived-count-is-a-
    projection``). Whether a *manual* pool count that disagrees with the pool rows is
    itself worth refusing is a separate question, and this guard does not answer it: it
    compares seats against the field, nothing else.
    """
    derived = _derived(draw_settings, pool_count=pool_count, field_size=field_size)
    if derived is None or derived.disagreement is None:
        return None
    if derived.disagreement.direction is not DisagreementDirection.unseated:
        return None
    return derived.disagreement


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
      director-or-derived-by-the-system``). Only the *cut* is unavailable, and only when
      the field is the bigger of the two — :func:`entrants_with_nowhere_to_go`.
    * **At most one problem**, which is the derivation's own rule — one impossible
      competition is one thing to fix.
    """
    derived = _derived(
        draw_settings,
        pool_count=pool_count,
        field_size=preview_field_size(max_players),
    )
    if derived is None or not derived.is_impossible:
        return None
    # Guarded by the line above, so this is not an index into a possibly-empty tuple:
    # ``is_impossible`` IS "there is a problem", and the derivation reports at most one.
    return derived.impossible_problems[0]

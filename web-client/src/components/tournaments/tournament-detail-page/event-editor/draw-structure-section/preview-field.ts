// The **field a draw-structure preview is derived against** (#1320), and the one
// sentence that says where that field came from.
//
// It lives here rather than in `data/draw-structure.ts` on purpose. That module's
// numbers are pinned vector-for-vector against a Python twin, and it says out loud that
// anything the vectors do not pin is drift waiting to happen. This is not one of the
// eight derivation inputs — it is the question of *which* field the derivation is fed,
// and the answer is a fact about the EVENT (does it have a cap?), not about the draw.
//
// Both this module and the live preview (chore 2c) read the label from here, so the
// heading block and the preview's "Preview basis" fact cannot come to say different
// things about the same number.

/**
 * The field a preview assumes when the event has **no cap**.
 *
 * `maxPlayers: null` is "no cap" and never zero (ADR-0935), so there is no number to
 * divide into groups — and a preview of nothing is not a preview. Sixteen is the
 * synthetic field we invent instead.
 *
 * ⚠️ **Mirrors `DEFAULT_UNCAPPED_FIELD` in `api/app/schedule_preview.py`**, which invents
 * the same synthetic field for the same reason. Neither copy is generated from the
 * other: change one and change this.
 */
export const DEFAULT_UNCAPPED_FIELD = 16

/** The field the Draw structure tab derives against: the director's cap, or the
 * uncapped default above. */
export const previewFieldSize = (maxPlayers: number | null): number =>
  maxPlayers ?? DEFAULT_UNCAPPED_FIELD

/**
 * Where that field came from, **in words a director can check**.
 *
 * ⚠️ This is the one place the implementation departs from the reference
 * (`docs/designs/rr-then-ko-draw-structure/README.md`), which labels the basis
 * `{n}-player cap` in *every* state — the uncapped one included. That sentence is false
 * for an uncapped event: nobody typed 16, there is no cap, and a director reading
 * "16-player cap" would go hunting the Basics tab for a number that is not there. #1320
 * requires the honest label, and the README records the deviation.
 */
export const previewBasisLabel = (maxPlayers: number | null): string =>
  maxPlayers === null
    ? `${DEFAULT_UNCAPPED_FIELD} players because this event has no cap`
    : `${maxPlayers}-player cap`

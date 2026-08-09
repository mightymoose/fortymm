import {
  deriveDrawStructure,
  type DrawStructureOptions,
} from '../../../data/draw-structure'
import type { DrawPreviewProps } from './draw-preview'
import { previewBasisLabel } from './preview-field'

/**
 * The eight derivation inputs of the reference's **"Nothing set"** state
 * (`docs/designs/rr-then-ko-draw-structure/nothing-set.png`): 32 players across 4 pool
 * reservations, every setting the system's. That derives 4 pools of 8, 2 qualifiers
 * apiece, an 8-player bracket with no byes, and 112 pool matches.
 *
 * The split is deliberately **even** and the draw deliberately **sound**, so an uneven,
 * disagreeing or impossible preview is something a test asks for by overriding an input
 * rather than something it gets by accident.
 */
export function buildDrawPreviewOptions(
  overrides: Partial<DrawStructureOptions> = {},
): DrawStructureOptions {
  return {
    previewFieldSize: 32,
    poolReservationCount: 4,
    poolCountMode: 'automatic',
    manualPoolCount: null,
    poolSizeMode: 'automatic',
    manualPoolSize: null,
    qualifiersMode: 'automatic',
    manualQualifiers: null,
    ...overrides,
  }
}

/**
 * Props for `DrawPreview` **derived from the eight inputs**, so a test states the
 * director's settings and gets the preview that follows from them.
 *
 * This is the builder to reach for: hand-writing a `DrawStructure` would let a test pin
 * a bracket size the arithmetic never produces, and the preview's whole job is to report
 * that arithmetic.
 */
export function buildDrawPreviewPropsFor(
  optionOverrides: Partial<DrawStructureOptions> = {},
): DrawPreviewProps {
  const options = buildDrawPreviewOptions(optionOverrides)
  return {
    structure: deriveDrawStructure(options),
    fieldSize: options.previewFieldSize,
    poolReservationCount: options.poolReservationCount,
    // The snake, which is the "Nothing set" state and what every cut already deals. The
    // hand-dealt mode is a prop a test overrides — it is not one of the eight derivation
    // inputs, because membership has no number to derive.
    membershipMode: 'snake',
    // The default builder treats the field as a cap the director set, which is the
    // reference's state. The uncapped sentence is a prop a test overrides.
    previewBasis: previewBasisLabel(options.previewFieldSize),
  }
}

/** Props for `DrawPreview` — the "Nothing set" state above, with any prop replaced
 * outright. */
export function buildDrawPreviewProps(
  overrides: Partial<DrawPreviewProps> = {},
): DrawPreviewProps {
  return { ...buildDrawPreviewPropsFor(), ...overrides }
}

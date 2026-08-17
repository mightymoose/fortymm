import {
  deriveDrawStructure,
  type DrawStructureOptions,
} from '../../../data/draw-structure'
import type { DrawPreviewProps } from './draw-preview'
import { previewBasisLabel } from './preview-field'

/** The reservation rows the default preview states on its fact line. **The factory's
 * own number, not a derivation input** (#1386): the derivation no longer reads the
 * reservation count, so the preview's prop is fed separately, exactly as
 * `draw-structure-section.tsx` feeds it from `event.reservations.length`. */
const DEFAULT_RESERVATION_COUNT = 4

/**
 * The seven derivation inputs of the default state: a **20-player cap**, every setting
 * the system's. The default divisor of five derives 4 groups of 5, 2 qualifiers apiece,
 * an 8-player bracket with no byes, and 40 group matches.
 *
 * The split is deliberately **even** and the draw deliberately **sound**, so an uneven,
 * disagreeing or impossible preview is something a test asks for by overriding an input
 * rather than something it gets by accident.
 */
export function buildDrawPreviewOptions(
  overrides: Partial<DrawStructureOptions> = {},
): DrawStructureOptions {
  return {
    previewFieldSize: 20,
    groupCountMode: 'automatic',
    manualGroupCount: null,
    groupSizeMode: 'automatic',
    manualGroupSize: null,
    qualifiersMode: 'automatic',
    manualQualifiers: null,
    ...overrides,
  }
}

/**
 * Props for `DrawPreview` **derived from the seven inputs**, so a test states the
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
    reservationCount: DEFAULT_RESERVATION_COUNT,
    // The default builder treats the field as a cap the director set, which is the
    // reference's state. The uncapped sentence is a prop a test overrides.
    previewBasis: previewBasisLabel(options.previewFieldSize),
  }
}

/** Props for `DrawPreview` — the default state above, with any prop replaced
 * outright. */
export function buildDrawPreviewProps(
  overrides: Partial<DrawPreviewProps> = {},
): DrawPreviewProps {
  return { ...buildDrawPreviewPropsFor(), ...overrides }
}

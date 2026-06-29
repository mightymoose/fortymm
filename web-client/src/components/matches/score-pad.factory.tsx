import type { ScorePadProps, ScorePadSideModel } from './score-pad'

/** A viewer-side model: `rita.kovac`, empty input, valid. */
export function buildScorePadMe(
  overrides: Partial<ScorePadSideModel> = {},
): ScorePadSideModel {
  return {
    name: 'rita.kovac',
    initials: 'RK',
    value: '',
    invalid: false,
    onChange: () => {},
    ...overrides,
  }
}

/** An opponent-side model: `nguyen.t`, empty input, valid. */
export function buildScorePadOpp(
  overrides: Partial<ScorePadSideModel> = {},
): ScorePadSideModel {
  return {
    name: 'nguyen.t',
    initials: 'NT',
    value: '',
    invalid: false,
    onChange: () => {},
    ...overrides,
  }
}

/**
 * Props for `ScorePad` — a best-of-5 game one in, viewer's row first, nothing
 * typed yet, ready to save (submit disabled until both sides are filled). The
 * games tally and copy mirror the scratchpad save surface.
 */
export function buildScorePadProps(
  overrides: Partial<ScorePadProps> = {},
): ScorePadProps {
  return {
    me: buildScorePadMe(),
    opp: buildScorePadOpp(),
    gamesTally: '0 – 0',
    scoreError: null,
    showBothRequired: false,
    inputsLocked: false,
    subtitle: 'Save this game to continue to game 2.',
    submitLabel: 'Save game & next →',
    canSubmit: false,
    onSubmit: () => {},
    ...overrides,
  }
}

import type { ScorePadSideProps } from './score-pad-side'

/**
 * Props for `ScorePadSide` — the viewer's own side (`'me'`), `rita.kovac`, an
 * empty input, valid and enabled.
 */
export function buildScorePadSideProps(
  overrides: Partial<ScorePadSideProps> = {},
): ScorePadSideProps {
  return {
    side: 'me',
    name: 'rita.kovac',
    initials: 'RK',
    value: '',
    onChange: () => {},
    ...overrides,
  }
}

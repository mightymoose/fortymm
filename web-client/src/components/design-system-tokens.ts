// The theme tokens the design system page shows, by name only, in the
// reference sheet's groups and order (references/design-system/: the Colour,
// Type and Foundations boards, their renderVals() data). Their values are
// never written here: the page reads each one from the stylesheet
// (tokenValue(), src/theme/token-value.ts), and a token named here that the
// theme lacks fails design-system-tokens.test.ts.

export type ColourGroup = {
  // The board's section: section-<id>.
  id: string
  title: string
  note: string
  // Swatches to a row.
  columns: 6 | 7 | 8
  tokens: string[]
}

// The Colour board's swatches.
export const colourGroups: ColourGroup[] = [
  {
    id: 'ink',
    title: 'Ink',
    note: 'Surfaces, dividers and edges. Darkest first.',
    columns: 7,
    tokens: [
      'ink-950',
      'ink-900',
      'ink-800',
      'ink-700',
      'ink-600',
      'ink-500',
      'ink-400',
    ],
  },
  {
    id: 'chalk-ball',
    title: 'Chalk and ball',
    note: 'Chalk is text. Ball (orange) is actions and selection only.',
    columns: 8,
    tokens: [
      'chalk-50',
      'chalk-100',
      'chalk-300',
      'chalk-500',
      'ball-200',
      'ball-400',
      'ball-500',
      'ball-600',
    ],
  },
  {
    id: 'status-hues',
    title: 'Status hues and fixed values',
    note: 'Each status has its own hue plus a non-colour cue.',
    columns: 6,
    tokens: [
      'red-400',
      'green-400',
      'amber-300',
      'blue-300',
      'danger',
      'border-field',
    ],
  },
  {
    id: 'action',
    title: 'Action and selection',
    note: 'Primary buttons, focus ring, links, selected tab, nav item or chip.',
    columns: 6,
    tokens: [
      'accent',
      'accent-hover',
      'accent-press',
      'accent-soft',
      'accent-text',
      'on-accent',
    ],
  },
  {
    id: 'status',
    title: 'Status',
    note: 'Live, serving, winner/loser, rating, conflict, rest, danger, success.',
    columns: 6,
    tokens: [
      'live',
      'serving',
      'winner',
      'loser',
      'rating-up',
      'rating-down',
      'conflict',
      'conflict-soft',
      'rest',
      'rest-soft',
      'danger-soft',
      'success',
    ],
  },
  {
    id: 'text-surface-border',
    title: 'Text, surfaces and borders',
    note: 'Most screens use bg-app and bg-panel only.',
    columns: 6,
    tokens: [
      'fg-1',
      'fg-2',
      'fg-3',
      'fg-placeholder',
      'fg-disabled',
      'bg-app',
      'bg-panel',
      'bg-group',
      'bg-hover',
      'border-subtle',
      'border-control',
      'border-field-hover',
    ],
  },
]

// The surfaces text is shown on (the Colour board's "Text on surfaces").
export const surfaces = ['bg-app', 'bg-panel', 'bg-group']

// The Type board's size scale, largest first.
export const textSizes = [
  'text-3xl',
  'text-2xl',
  'text-xl',
  'text-lg',
  'text-md',
  'text-base',
  'text-sm',
  'text-xs',
]

// The Type board's line heights, and what each is for.
export const lineHeights: { token: string; use: string }[] = [
  { token: 'lh-tight', use: 'h1' },
  { token: 'lh-snug', use: 'h2, h3, labels' },
  { token: 'lh-normal', use: 'body, page default' },
]

// The Foundations board's spacing scale.
export const spaces = [
  's-1',
  's-2',
  's-3',
  's-4',
  's-5',
  's-6',
  's-8',
  's-12',
  's-16',
]

// The Foundations board's radii, and what each is for.
export const radii: { token: string; use: string }[] = [
  { token: 'r-sm', use: 'chips, inputs' },
  { token: 'r-md', use: 'buttons, cards' },
  { token: 'r-lg', use: 'sheets, dialogs' },
  { token: 'r-pill', use: 'filter chips' },
]

// Every token above, and the others the boards name in their captions.
export const tokensShown = [
  ...colourGroups.flatMap((group) => group.tokens),
  ...surfaces,
  ...textSizes,
  ...lineHeights.map((height) => height.token),
  ...spaces,
  ...radii.map((radius) => radius.token),
  'font-ui',
  'font-num',
  'font-display',
  'shadow-overlay',
  'shadow-tooltip',
  'focus-ring',
]

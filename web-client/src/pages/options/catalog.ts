// The option previews at /options: throwaway pages for choosing a new Home
// and a new loading screen. The e2e suite imports this list too, so it
// stays plain data with no imports.

export type OptionKind = 'home' | 'loading'

export type Option = {
  kind: OptionKind
  slug: string
  title: string
  pitch: string
  recommended?: true
}

export const options = [
  {
    kind: 'home',
    slug: 'home-welcome',
    title: 'Plain and welcoming',
    pitch:
      'For someone who just opened FortyMM. The hero line, two actions and the commitment once. It works with no data, but it shows nothing personal.',
    recommended: true,
  },
  {
    kind: 'home',
    slug: 'home-today',
    title: 'Your day first',
    pitch:
      'For a player at a tournament. Next match, table and rest come first, then results with rating changes. It needs a demo empty state, because most visitors have no tournament today.',
  },
  {
    kind: 'home',
    slug: 'home-join',
    title: 'Join with a code',
    pitch:
      'For someone who just walked into a venue. The 6-character code is the whole page. Fast at the desk, but it says little about what else FortyMM does.',
  },
  {
    kind: 'home',
    slug: 'home-organizer',
    title: 'Organizer first',
    pitch:
      'For the person running today’s tournament. Finish time against plan, the decision to make, then every table. Dense and useful for one person, wrong for every player.',
  },
  {
    kind: 'home',
    slug: 'home-club',
    title: 'Club results',
    pitch:
      'For a club member following from home. Live matches, today’s results and the club ladder. It needs a club, which a new guest doesn’t have.',
  },
  {
    kind: 'loading',
    slug: 'loading-still',
    title: 'Still',
    pitch:
      'The wordmark and one status line. Nothing moves until it fades out. After 4 seconds the line says the server is starting, which covers a cold start honestly.',
    recommended: true,
  },
  {
    kind: 'loading',
    slug: 'loading-progress',
    title: 'Honest progress',
    pitch:
      'Each real step gets a check as it finishes. It tells you where a slow load is stuck, but today there are only two steps, so it can look thin.',
  },
  {
    kind: 'loading',
    slug: 'loading-frame',
    title: 'Page frame first',
    pitch:
      'The app’s header shows at once, with a notice where the page will go. It feels fastest, but it changes the contract. There is no cover, so the fade-out applies to the notice.',
  },
  {
    kind: 'loading',
    slug: 'loading-landing',
    title: 'One-shot landing',
    pitch:
      'The ball drops once and stops on the line, then the wordmark appears. It keeps a brand moment and finishes inside the 900ms minimum, but it is motion nobody asked for.',
  },
] as const satisfies readonly Option[]

export type OptionSlug = (typeof options)[number]['slug']

export const optionPath = (slug: OptionSlug) => `/options/${slug}`

export function findOption(slug: string): Option | undefined {
  return options.find((option) => option.slug === slug)
}

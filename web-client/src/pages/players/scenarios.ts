// How the fake API in mockApi.ts answers, chosen by a mockup's `?state=`
// search param. `loading` never answers, so the skeleton stays on screen.
// This file stays small, because the route files import it.
export const listScenarios = [
  'ready',
  'loading',
  'empty',
  'error',
  'unreachable',
  'rate-limited',
] as const

export const detailScenarios = [
  'ready',
  'loading',
  'not-found',
  'error',
  'unreachable',
  'rate-limited',
] as const

export type ListScenario = (typeof listScenarios)[number]
export type DetailScenario = (typeof detailScenarios)[number]
export type Scenario = ListScenario | DetailScenario

export const scenarioLabels: Record<Scenario, string> = {
  ready: 'Ready',
  loading: 'Loading',
  empty: 'Empty',
  'not-found': 'Not found',
  error: 'Error',
  unreachable: 'Offline',
  'rate-limited': 'Rate limited',
}

// A mockup route's search params. An unknown `state` reads as ready.
export function scenarioSearch<S extends Scenario>(options: readonly S[]) {
  return (search: Record<string, unknown>): { state?: S } =>
    options.includes(search.state as S) ? { state: search.state as S } : {}
}

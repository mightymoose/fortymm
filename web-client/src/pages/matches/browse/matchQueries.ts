import { queryOptions } from '@tanstack/react-query'
import { loadMatch, loadMatches } from './sampleMatches'

const MATCHES_KEY = ['v1', 'matches'] as const

// Every match, newest first.
export function matchesQuery() {
  return queryOptions({ queryKey: [...MATCHES_KEY, 'list'], queryFn: loadMatches })
}

// One match, or null if there's no match with that id.
export function matchQuery(id: string) {
  return queryOptions({ queryKey: [...MATCHES_KEY, 'detail', id], queryFn: () => loadMatch(id) })
}

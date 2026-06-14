// In-memory, front-end-only store for the Tournament CRUD prototype. There is
// no backend: the seed loads once, mutations rewrite module state and notify
// subscribers, and everything resets on page reload. The route components read
// through `useTournaments()` / `useTables()` and call the mutators below.

import { useSyncExternalStore } from 'react'

import { genId } from './helpers'
import { seedTables, seedTournaments } from './seed'
import type { Tournament, TournamentEvent } from './types'

let tournaments: Tournament[] = seedTournaments()
const tables = seedTables()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Stable getter: returns the current array reference (which only changes on
// mutation), so `useSyncExternalStore` sees a new snapshot exactly when it must.
function getSnapshot() {
  return tournaments
}

/** Subscribe a component to the tournament list; re-renders on any mutation. */
export function useTournaments(): Tournament[] {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** The (static) table catalogue. */
export function useTables() {
  return tables
}

/** Derive a slug id from the tournament name plus a short random suffix. */
function slugId(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'tournament'
  return `${base}-${genId('').split('-').pop()}`
}

/** Create a tournament from a draft (no id yet) and return its new id. */
export function createTournament(draft: Omit<Tournament, 'id'>): string {
  const id = slugId(draft.name)
  tournaments = [{ ...draft, id }, ...tournaments]
  emit()
  return id
}

export function updateTournament(next: Tournament): void {
  tournaments = tournaments.map((t) => (t.id === next.id ? next : t))
  emit()
}

export function deleteTournament(id: string): void {
  tournaments = tournaments.filter((t) => t.id !== id)
  emit()
}

export function createEvent(tournamentId: string, ev: TournamentEvent): void {
  tournaments = tournaments.map((t) =>
    t.id === tournamentId ? { ...t, events: [...t.events, ev] } : t,
  )
  emit()
}

export function updateEvent(tournamentId: string, ev: TournamentEvent): void {
  tournaments = tournaments.map((t) =>
    t.id === tournamentId
      ? { ...t, events: t.events.map((e) => (e.id === ev.id ? ev : e)) }
      : t,
  )
  emit()
}

export function deleteEvent(tournamentId: string, eventId: string): void {
  tournaments = tournaments.map((t) =>
    t.id === tournamentId
      ? { ...t, events: t.events.filter((e) => e.id !== eventId) }
      : t,
  )
  emit()
}

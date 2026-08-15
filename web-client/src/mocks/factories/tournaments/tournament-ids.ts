/** Stable UUID ids for the tournaments seeded into the dev world (#1229, duplicates
 * #1211, #1323).
 *
 * The route Zod-validates `$tournamentId` as a uuid at the boundary, BEFORE any fetch
 * (`tournaments.$tournamentId.tsx`, ADR-1001) — a non-uuid segment throws `notFound()`.
 * A hand-written slug id (`bay-area-open-2026`) therefore 404s its own detail page
 * under `npm run dev` even though the seed exists — the same class of bug `mockUuid`
 * fixed for matches (#958). `mockUuid` derives a deterministic v4-shaped id from a
 * readable label, so a seed keeps the same id across reloads while call sites still
 * say what the tournament *is*.
 *
 * Kept in their own module rather than `tournaments-store.ts`: the admin solve-ledger
 * seed (`buildAdminSolveLedgerSeed` below) needs the same ids so its tournament links
 * resolve too, and `tournaments-store.ts` already imports FROM this factory file —
 * exporting the ids from the store instead would create an import cycle.
 */
import { mockUuid } from '@/mocks/mock-uuid'

export const BAY_AREA_OPEN_ID = mockUuid('bay-area-open-2026')
export const SUMMER_SLAM_ID = mockUuid('summer-slam-2026')
export const CLUB_CHAMPS_ID = mockUuid('club-champs-2026')
export const GARAGE_INVITATIONAL_ID = mockUuid('garage-invitational-2026')
export const GOLDEN_STATE_CLASSIC_ID = mockUuid('golden-state-classic-2026')
export const LEAGUE_OFFICE_DRAFT_ID = mockUuid('league-office-draft-2027')

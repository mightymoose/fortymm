// The **stages** boundary (ADR 20260815): where an event's `stages` array stops being
// bytes off the wire and becomes a typed domain value.
//
// A stage is a row the event owns, minted by the server from a template keyed on the
// event's `drawType` — never authored by a director. Parsed here, at the fetch
// boundary, for the same reason the fixtures and results are (`.claude/rules/parse-at-boundaries.md`):
// `schema.d.ts` is a compile-time claim, not a runtime guarantee, and a stage whose
// `draw_type` is not one of the three single-stage kinds must fail HERE — inside the
// `queryFn` — rather than reach `shapeForStage` (`./draw`), whose whole point is that
// it has no arm for anything else.

import { z } from 'zod'

import { stageDrawTypeSchema } from './draw-types'
import type { Stage } from './types'

/** The wire shape of one stage (`EventStageRead`), as it really arrives: snake_case,
 * `draw_type` restricted to the single-stage vocabulary. */
const stageWireSchema = z.object({
  id: z.string(),
  position: z.number().int(),
  draw_type: stageDrawTypeSchema,
})

/** The parser: one wire stage → one domain `Stage`. Annotated `: Stage` for the same
 * reason `fixtureSchema` is (`./fixtures`) — the transform and the domain interface
 * cannot drift apart. */
const stageSchema = stageWireSchema.transform(
  (s): Stage => ({ id: s.id, position: s.position, drawType: s.draw_type }),
)

/** An event's whole `stages` array. Never empty on a real payload — every event holds
 * at least one stage from the moment it exists (ADR 20260815 decision 3) — but that is
 * a fact `.array()` cannot itself enforce, so it is not asserted here; a stage-less
 * event simply renders nothing that reads `stages` as non-empty. */
export const stagesSchema = z.array(stageSchema)

/**
 * Parse an event's `stages` off the wire, or throw.
 *
 * Takes `unknown`, deliberately — the same discipline `parseFixtures` follows, for the
 * same reason: the value is typed `EventStageRead[]` by the generated schema, and that
 * type is exactly the claim this function exists to check.
 *
 * Throws a `ZodError`, from inside the tournament queries' `queryFn`, so a malformed
 * `stages` array fails the *query* rather than reaching a renderer that walks fixtures
 * by `stageId` against it.
 */
export function parseStages(input: unknown): Stage[] {
  return stagesSchema.parse(input)
}

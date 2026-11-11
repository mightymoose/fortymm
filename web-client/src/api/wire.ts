import type * as z from 'zod'
import type { components } from './schema.gen.ts'

// The boundary between the api's wire format and the app's own types.
//
// Every answer from the api is parsed by a hand-written zod schema whose
// input is the wire shape and whose output is what the app works with. The
// output may differ from the wire (camelCase keys, Date values), so the
// transform goes in the schema (`.transform(...)`), and app code depends only
// on the output type, never on schema.gen.ts.
//
// The input side must not drift from the api: fromWire binds it to a schema
// of the api's OpenAPI document, as generated into schema.gen.ts. If the
// schema's input type and the document's type differ in either direction (a
// field renamed, removed or added, a value changed), the call fails
// web-client:typecheck.
//
//   export const healthDocument = fromWire('HealthDocument')(
//     z.object({ ... }).transform((wire) => appValue),
//   )

// A schema of the api's OpenAPI document, by its name there.
export type WireName = keyof components['schemas']
export type Wire<Name extends WireName> = components['schemas'][Name]

// Each assignable to the other: the same shape, as far as a parsed body goes.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

type InputMatches<Schema extends z.ZodType, Name extends WireName> =
  Same<z.input<Schema>, Wire<Name>> extends true
    ? unknown
    : {
        error: `This schema's input is not the api's ${Name}`
        input: z.input<Schema>
        wire: Wire<Name>
      }

// Returns the schema unchanged; only the type check does anything. Curried so
// the name is given and the schema's type is inferred.
export function fromWire<Name extends WireName>(_name: Name) {
  return <Schema extends z.ZodType>(
    schema: Schema & InputMatches<Schema, Name>,
  ): Schema => schema
}

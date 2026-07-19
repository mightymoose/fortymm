/** A backstop list for a runtime that predates `Intl.supportedValuesOf`
 * (Node < 18 / older Safari) — a handful of common zones plus `UTC`, so the
 * `TimezoneSelect` picker is never empty. In every runtime this app actually
 * ships to, the real `Intl` set (≈400 zones) is used instead; this only ever
 * fills in for one that cannot enumerate them. */
const FALLBACK_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
  'Australia/Sydney',
]

/** Every IANA timezone the runtime can name (`Intl.supportedValuesOf('timeZone')`),
 * or a small fallback where that API is absent. The current `value` is folded in
 * even if the runtime does not list it, so a zone the server holds but this browser
 * has never heard of is still selectable and never silently dropped.
 *
 * The client does **no** timezone arithmetic (ADR 20260719) — it only names the zone
 * and hands it back; the server composes the instants. So this reads the whole list
 * straight off `Intl` rather than carrying its own copy of the tz database. */
export function ianaTimezones(current?: string): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: 'timeZone') => string[]
  }
  const base =
    typeof intl.supportedValuesOf === 'function'
      ? intl.supportedValuesOf('timeZone')
      : FALLBACK_TIMEZONES
  if (current && !base.includes(current)) return [current, ...base]
  return base
}

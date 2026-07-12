/** Stable UUIDs for mock data.
 *
 * Match ids are UUIDs on the API, and the `$matchId` routes reject anything
 * else before they fetch (`@/lib/match-id`). Mock ids therefore have to be
 * UUID-shaped or the mock world can't reach its own match pages (#958) — a
 * hand-written `m-2207` 404s under `npm run dev` even though the seed exists.
 *
 * `mockUuid` derives one deterministically from a readable label, so a seed
 * keeps the same id across reloads (bookmarkable dev URLs, stable e2e stubs)
 * while call sites still say what the match *is* rather than a bare hex blob.
 */

/** FNV-1a. Cheap, well-spread, and enough for fixture ids. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** A deterministic v4-shaped UUID for `label`. Distinct labels get distinct
 * ids; the same label always gets the same id. */
export function mockUuid(label: string): string {
  const hex = [0, 1, 2, 3]
    .map((i) => fnv1a(`${label}:${i}`).toString(16).padStart(8, '0'))
    .join('')
  // Pin the version (4) and variant (8) nibbles so these parse as real v4s.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

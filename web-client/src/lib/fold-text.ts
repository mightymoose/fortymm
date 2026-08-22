/**
 * Fold text for client-side substring search: case and diacritics both ignored.
 *
 * `toLowerCase()` folds case and never folds accents, so `"Área".toLowerCase()`
 * is `"área"` and a user on an ASCII keyboard cannot find the row. This helper
 * is the single place that rule lives — every client-side list search folds the
 * typed text and the searched value through it, so a new list cannot quietly
 * reintroduce the defect.
 *
 * Folding affects matching only. It never changes what is displayed, how rows
 * are sorted, or what is stored.
 */

// The combining diacritical marks block, and only it. `\p{Diacritic}` looks
// like the right property and is not: it also covers U+3099 / U+309A, the
// Japanese voiced sound marks, so `が` would fold to `か` and `ka` would match
// `ga`. Non-Latin text must match exactly as it does today.
const COMBINING_MARKS = /[\u0300-\u036f]/g

/**
 * Lowercase `value` and strip its combining marks.
 *
 * Apply it to both sides of a comparison. Folding one side only is not a fold.
 * Because it is symmetric it can only widen results: anything that matches
 * today still matches.
 *
 * @example
 * foldForSearch('Área da Baía Aberto') // 'area da baia aberto'
 */
export function foldForSearch(value: string): string {
  return (
    value
      .toLowerCase()
      // Decompose so a precomposed `á` and an `a` plus a combining acute reduce
      // to the same thing, then drop the marks.
      .normalize('NFD')
      .replace(COMBINING_MARKS, '')
      // Recompose. Without this, NFD leaks out of the helper and silently
      // widens substring matching for scripts that decompose but carry no
      // combining marks: decomposed `각` would *contain* decomposed `가`, and
      // Hangul search would stop behaving as it does today.
      .normalize('NFC')
  )
}

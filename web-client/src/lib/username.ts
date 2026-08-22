/**
 * The username rule, mirrored once for the whole web client.
 *
 * The API owns this rule. `USERNAME_PATTERN`, `USERNAME_MIN_LENGTH` and
 * `USERNAME_MAX_LENGTH` in `api/app/schemas/session.py` are the single source
 * of truth, and every write path enforces them server-side. Client-side
 * validation exists only for fast feedback.
 *
 * It lives here rather than in a component because it had drifted into three
 * disagreeing copies: the admin add-user modal accepted `AB` and `Bob`, which
 * the API rejects with a 422 the form said was fine.
 */

/** Mirrors `USERNAME_PATTERN`. Lowercase alphanumerics with optional dots,
 * hyphens and underscores between them, starting and ending alphanumeric. */
export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,38}[a-z0-9])?$/
/** Mirrors `USERNAME_MIN_LENGTH`. */
export const USERNAME_MIN = 3
/** Mirrors `USERNAME_MAX_LENGTH`. */
export const USERNAME_MAX = 40

/**
 * Whether `value` is a username the API will accept.
 *
 * The pattern already pins both ends of the length range, but the constants are
 * checked explicitly so a caller cannot be right about the shape and wrong
 * about the bounds.
 */
export function isValidUsername(value: string): boolean {
  return value.length >= USERNAME_MIN && value.length <= USERNAME_MAX && USERNAME_RE.test(value)
}

/** The one-line description of the rule, for a form hint. */
export const USERNAME_HINT = `Lowercase letters, numbers, dots, hyphens and underscores. ${USERNAME_MIN}–${USERNAME_MAX} characters.`

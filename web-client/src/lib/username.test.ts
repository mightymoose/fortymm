import {
  USERNAME_HINT,
  USERNAME_MAX,
  USERNAME_MIN,
  hasDisallowedUsernameChar,
  isValidUsername,
} from './username'

// This module mirrors `USERNAME_PATTERN`, `USERNAME_MIN_LENGTH` and
// `USERNAME_MAX_LENGTH` from `api/app/schemas/session.py`. Nothing generated
// pins the mirror to the API, so these cases are the only thing standing
// between a drifted copy and a 422 the form said was fine.
describe('isValidUsername', () => {
  it('accepts a name the API accepts', () => {
    expect(isValidUsername('jamie.tran')).toBe(true)
    expect(isValidUsername('jamie.tran-1')).toBe(true)
    expect(isValidUsername('a.b')).toBe(true)
    expect(isValidUsername('a__b')).toBe(true)
  })

  it('rejects a single character, which the pattern alone would admit', () => {
    // Load-bearing. `^[a-z0-9](?:[a-z0-9._-]{1,38}[a-z0-9])?$` matches `'a'`
    // through its optional group, so USERNAME_MIN is the *only* thing
    // rejecting it. Delete that check as redundant and this is the test that
    // reds. The API agrees: `min_length=USERNAME_MIN_LENGTH` on RbacUserCreate.
    expect(isValidUsername('a')).toBe(false)
  })

  it('holds both ends of the length range exactly', () => {
    expect(isValidUsername('a'.repeat(USERNAME_MIN - 1))).toBe(false)
    expect(isValidUsername('a'.repeat(USERNAME_MIN))).toBe(true)
    expect(isValidUsername('a'.repeat(USERNAME_MAX))).toBe(true)
    expect(isValidUsername('a'.repeat(USERNAME_MAX + 1))).toBe(false)
  })

  it('rejects the shapes the API rejects with a 422', () => {
    expect(isValidUsername('Bob')).toBe(false) // uppercase
    expect(isValidUsername('árni.pal')).toBe(false) // an accent
    expect(isValidUsername('arni.pál')).toBe(false) // an accent anywhere
    expect(isValidUsername('.leading')).toBe(false) // starts with a separator
    expect(isValidUsername('trailing-')).toBe(false) // ends with a separator
    expect(isValidUsername('has space')).toBe(false)
    expect(isValidUsername('')).toBe(false)
  })
})

describe('hasDisallowedUsernameChar', () => {
  it('spots a character outside the allowed set', () => {
    expect(hasDisallowedUsernameChar('Bob')).toBe(true)
    expect(hasDisallowedUsernameChar('has space')).toBe(true)
    expect(hasDisallowedUsernameChar('árni')).toBe(true)
  })

  it('passes a name built only from allowed characters', () => {
    // True even for `.leading`, which is invalid for a different reason. That
    // split is the point: settings surfaces a bad character while typing and
    // gates the rest on blur.
    expect(hasDisallowedUsernameChar('jamie.tran-1')).toBe(false)
    expect(hasDisallowedUsernameChar('.leading')).toBe(false)
  })
})

describe('USERNAME_HINT', () => {
  it('does not describe as acceptable anything the rule refuses', () => {
    // A hint that lists only the characters and the length range describes
    // `.leading` as valid while the form disables submit. It must name the
    // start-and-end rule too.
    expect(isValidUsername('.leading')).toBe(false)
    expect(USERNAME_HINT).toMatch(/start and end/i)
    expect(USERNAME_HINT).toContain(String(USERNAME_MIN))
    expect(USERNAME_HINT).toContain(String(USERNAME_MAX))
  })
})

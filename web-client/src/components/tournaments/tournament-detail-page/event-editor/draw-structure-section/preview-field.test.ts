import {
  DEFAULT_UNCAPPED_FIELD,
  previewBasisLabel,
  previewFieldSize,
} from './preview-field'

describe('previewFieldSize', () => {
  it('derives against the cap the director set', () => {
    expect(previewFieldSize(32)).toBe(32)
  })

  it('falls back to the uncapped default when the event has no cap', () => {
    expect(previewFieldSize(null)).toBe(16)
    expect(DEFAULT_UNCAPPED_FIELD).toBe(16)
  })
})

describe('previewBasisLabel', () => {
  it('names the cap the field came from', () => {
    expect(previewBasisLabel(32)).toBe('32-player cap')
  })

  // The deviation #1320 requires: the reference says `16-player cap` here, which is a
  // cap nobody set. A director who read that would go looking for it on Basics.
  it('says why the field is 16 when the event has no cap — never calls it a cap', () => {
    expect(previewBasisLabel(null)).toBe(
      '16 players because this event has no cap',
    )
    expect(previewBasisLabel(null)).not.toContain('cap.')
    expect(previewBasisLabel(null)).not.toMatch(/16-player cap/)
  })
})

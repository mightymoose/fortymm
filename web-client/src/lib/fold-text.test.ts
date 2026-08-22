import { foldForSearch } from './fold-text'

describe('foldForSearch', () => {
  it('folds case, the way the searches already did', () => {
    expect(foldForSearch('Winter Classic 2025')).toBe('winter classic 2025')
  })

  it('strips Latin diacritics so an ASCII keyboard can reach an accented name', () => {
    expect(foldForSearch('Área da Baía Aberto')).toBe('area da baia aberto')
    expect(foldForSearch('Café Staff')).toBe('cafe staff')
  })

  it('folds a precomposed and a decomposed accent to the same thing', () => {
    const precomposed = '\u00e1' // a single code point
    const decomposed = 'a\u0301' // `a` plus a combining acute

    expect(precomposed).not.toBe(decomposed)
    expect(foldForSearch(precomposed)).toBe(foldForSearch(decomposed))
  })

  it('strips the combining dot Turkish İ lowercases into', () => {
    expect(foldForSearch('İstanbul')).toBe('istanbul')
  })

  it('leaves Japanese voiced sound marks alone, so `ka` never matches `ga`', () => {
    // The reason this helper strips the combining-marks *block* rather than
    // testing `\p{Diacritic}`: that property covers U+3099/U+309A too.
    expect(foldForSearch('が')).toBe('が')
    expect(foldForSearch('ば')).toBe('ば')
    expect(foldForSearch('が').includes(foldForSearch('か'))).toBe(false)
  })

  it('leaves Hangul, Cyrillic and Han text unchanged', () => {
    expect(foldForSearch('한글')).toBe('한글')
    expect(foldForSearch('Москва')).toBe('москва')
    expect(foldForSearch('北京')).toBe('北京')
  })

  it('does not widen Hangul substring matching', () => {
    // The trailing NFC earns its keep here. Fold to NFD and stop, and decomposed
    // `각` *contains* decomposed `가` — so a Hangul search would start matching
    // rows it does not match today.
    expect(foldForSearch('각')).toBe('각')
    expect(foldForSearch('각').includes(foldForSearch('가'))).toBe(false)
  })

  it('is symmetric, so an accented query finds an unaccented row', () => {
    expect(foldForSearch('Bay Area').includes(foldForSearch('Área'))).toBe(true)
  })

  it('leaves a string with nothing to fold exactly as it was', () => {
    expect(foldForSearch('')).toBe('')
    expect(foldForSearch('tournament.view')).toBe('tournament.view')
  })

  it('does not fold ligatures and stroked letters, an accepted limit', () => {
    // `ß`, `ø`, `ł` and `đ` carry no separate combining mark, so no amount of
    // mark-stripping reaches them. Pinned so a later "improvement" is a choice.
    expect(foldForSearch('Straße')).toBe('straße')
    expect(foldForSearch('Ø')).toBe('ø')
  })
})

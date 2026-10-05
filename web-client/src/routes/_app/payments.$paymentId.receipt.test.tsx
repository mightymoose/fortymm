import { isNotFound } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'

import { Route } from './payments.$paymentId.receipt'

const parseParams = (
  Route.options.params as { parse: (raw: unknown) => { paymentId: string } }
).parse

describe('/payments/$paymentId/receipt', () => {
  it('parses a uuid payment id', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
    expect(parseParams({ paymentId: id })).toEqual({ paymentId: id })
  })

  it.each(['abc', 'new', '%20', ''])(
    'treats %j as a URL that names no receipt, before any request',
    (raw) => {
      let thrown: unknown
      try {
        parseParams({ paymentId: raw })
      } catch (error) {
        thrown = error
      }
      expect(isNotFound(thrown)).toBe(true)
    },
  )

  it('has its own not-found boundary', () => {
    expect(Route.options.notFoundComponent).toBeDefined()
  })
})

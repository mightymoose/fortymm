import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { buildApp } from '../../app.ts'

describe('GET /v1/health', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('responds with 200', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/health' })

    expect(response.statusCode).toBe(200)
  })

  it('returns an empty JSON body', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/health' })

    expect(response.headers['content-type']).toMatch(/application\/json/)
    expect(response.json()).toEqual({})
  })

  it('does not respond on a non-versioned path', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(404)
  })
})

import Fastify from 'fastify'
import type { FastifyInstance, FastifyServerOptions } from 'fastify'

import { healthRoutes } from './routes/health.ts'

export const buildApp = async (
  options: FastifyServerOptions = {},
): Promise<FastifyInstance> => {
  const app = Fastify(options)

  await app.register(healthRoutes, { prefix: '/v1' })

  return app
}

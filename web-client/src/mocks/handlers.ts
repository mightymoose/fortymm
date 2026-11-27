import { health } from './health.ts'

// The api as tests see it by default: every endpoint answering successfully.
export const handlers = [health.ok()]

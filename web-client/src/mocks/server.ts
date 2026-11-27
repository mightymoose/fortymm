import { setupServer } from 'msw/node'
import { handlers } from './handlers.ts'

// The MSW server for unit tests; started in setupTests.ts.
export const server = setupServer(...handlers)

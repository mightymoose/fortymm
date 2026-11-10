import { createOpenApiHttp } from 'openapi-msw'
import { setupServer } from 'msw/node'
import { apiBaseUrl } from '../../api/client.ts'
import type { paths } from '../../api/schema.gen.ts'

// The stand-in for the api in component tests: MSW answers the requests the
// app's client sends, at the network level, so the client and everything
// above it run for real. src/test/setup.ts starts it, resets its handlers
// after each test, and fails a test that sent a request no handler answered.
// A test says how the api answers with server.use(...handlers).
export const server = setupServer()

// MSW's `http`, typed from the api's OpenAPI document: a handler for a path
// the document doesn't have, or one that answers a status or body the
// document doesn't declare for that path, fails web-client:typecheck. Use
// `response(status).json(body)` in handlers, not HttpResponse, to get the
// body checked. For an answer the document doesn't declare (on purpose),
// use `response.untyped(...)` or `http.untyped`.
export const http = createOpenApiHttp<paths>({ baseUrl: apiBaseUrl })

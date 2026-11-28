import type { AnyHandler } from 'msw'

// The api as the dev server sees it (see src/main.tsx): only the endpoints the api doesn't serve
// yet, while the web client is built ahead of it. Every other request goes to the real api.
// Each handler here is temporary: delete it once the api serves that endpoint.
export const devHandlers: AnyHandler[] = []

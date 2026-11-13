import { defineConfig, devices, type Project } from '@playwright/test'

// The cross-app suite: what can fail only because of how the apps are served
// or connected, such as the hosting in front of the web client and its proxy
// to the api. Anything one app can prove by itself belongs in that app's own
// validate. Run it with ./bin/mise run e2e.
//
// Every project drives the web client's production hosting, the Worker in
// web-client/worker/, at an address set by compose.dev.yaml (a project whose
// address is empty is left out). What a Worker does with /api/* depends on
// the api it was given (its API_ORIGIN), so each kind has its own address:
//
// - worker (WORKER_URL): the rules every Worker keeps, whatever its api:
//   tests/hosting.spec.ts and tests/hosting-rules.spec.ts.
// - worker-no-api (NO_API_WORKER_URL): a Worker given no api, as the
//   production one: /api/* is a plain 404. tests/hosting-no-api.spec.ts.
// - api-journey (API_WORKER_URL): a Worker given a real api: the health page
//   shows the api and its database healthy. tests/health.spec.ts.
// - worker-api (API_WORKER_URL): the same Worker, its other rules with a real
//   api: the api's own answers, never kept by the app. tests/hosting-api.spec.ts.
// - worker-proxy (ECHO_WORKER_URL): a Worker given api-echo, which answers
//   with what it received: what is forwarded, and to where.
//   tests/hosting-proxy.spec.ts.
// - worker-unreachable (UNREACHABLE_WORKER_URL): a Worker given an api it
//   can't reach. tests/hosting-unreachable.spec.ts.
//
// The e2e task sets every address, to the local Workers runtime.
// web-client:hosting-check runs worker and api-journey (or worker-no-api)
// against a deployment.
//
// Every project runs only once its address serves this checkout's build
// (tests/hosting-serves-build.setup.ts, one setup project per address).
const addresses = {
  worker: process.env.WORKER_URL,
  'worker-no-api': process.env.NO_API_WORKER_URL,
  'api-journey': process.env.API_WORKER_URL,
  'worker-api': process.env.API_WORKER_URL,
  'worker-proxy': process.env.ECHO_WORKER_URL,
  'worker-unreachable': process.env.UNREACHABLE_WORKER_URL,
}
const tests: Record<keyof typeof addresses, RegExp> = {
  worker: /\/hosting(-rules)?\.spec\.ts$/,
  'worker-no-api': /\/hosting-no-api\.spec\.ts$/,
  'api-journey': /\/health\.spec\.ts$/,
  'worker-api': /\/hosting-api\.spec\.ts$/,
  'worker-proxy': /\/hosting-proxy\.spec\.ts$/,
  'worker-unreachable': /\/hosting-unreachable\.spec\.ts$/,
}

const projects: Project[] = []
const setups = new Map<string, string>()
for (const [name, address] of Object.entries(addresses)) {
  if (!address) continue
  let setup = setups.get(address)
  if (!setup) {
    setup = `serves-build ${new URL(address).host}`
    setups.set(address, setup)
    projects.push(project(setup, address, /hosting-serves-build\.setup\.ts$/))
  }
  projects.push({
    ...project(name, address, tests[name as keyof typeof addresses]),
    dependencies: [setup],
  })
}
if (projects.length === 0) {
  throw new Error('No Worker address is set; run ./bin/mise run e2e')
}

export default defineConfig({
  testDir: './tests',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure' },
  projects,
})

function project(name: string, baseURL: string, testMatch: RegExp): Project {
  const { origin, protocol } = new URL(baseURL)
  return {
    name,
    testMatch,
    use: {
      // The full Chromium, not the headless shell, which ignores the flag
      // below, so service workers would not run.
      ...devices['Desktop Chrome'],
      channel: 'chromium',
      baseURL,
      // Service workers run only in a secure context: https, or localhost.
      // A deployment is https; the stack's services are plain http on its
      // network, so tell Chromium to treat their origin as secure.
      launchOptions: {
        args:
          protocol === 'http:'
            ? [`--unsafely-treat-insecure-origin-as-secure=${origin}`]
            : [],
      },
    },
  }
}

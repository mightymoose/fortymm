import { defineConfig, devices, type Project } from '@playwright/test'

// The cross-app suite: what can fail only because of how the apps are served
// or connected, such as the hosting in front of the web client. Anything one
// app can prove by itself belongs in that app's own validate. Run it with
// ./bin/mise run e2e.
//
// The web client's production hosting is the Worker in web-client/worker/.
// The projects drive it in three configurations (set by compose.dev.yaml; a
// project whose URL is empty is left out):
// - worker and api-wiring (WORKER_URL): the Worker with the api behind its
//   proxy. In the stack, the local Workers runtime (web-client-worker)
//   forwarding /api/* to api-release; or a pull request's preview, with that
//   pull request's api. worker holds the hosting's rules
//   (tests/hosting*.spec.ts), api-wiring the web client reaching the api
//   through it (tests/health.spec.ts). ./bin/mise run web-client:hosting-check
//   runs these two alone against any address, such as a deployment.
// - worker-without-api (WORKER_WITHOUT_API_URL): the Worker deployed without
//   an api origin, as the production Worker is
//   (tests/api-unconfigured.spec.ts).
// - worker-api-unreachable (WORKER_API_UNREACHABLE_URL): the Worker with an
//   api it can't reach (tests/api-unreachable.spec.ts).
// The last two run only in the stack.
const workerURL = process.env.WORKER_URL
const withoutApiURL = process.env.WORKER_WITHOUT_API_URL
const apiUnreachableURL = process.env.WORKER_API_UNREACHABLE_URL

const projects: Project[] = []
if (workerURL) {
  // Every test against the address runs only once it serves this checkout's
  // build (tests/hosting-serves-build.setup.ts).
  projects.push(
    project('worker-serves-build', workerURL, /hosting-serves-build\.setup\.ts/),
    {
      ...project('worker', workerURL, /hosting.*\.spec\.ts/),
      dependencies: ['worker-serves-build'],
    },
    {
      ...project('api-wiring', workerURL, /health\.spec\.ts/),
      dependencies: ['worker-serves-build'],
    },
  )
}
if (withoutApiURL) {
  projects.push(
    project('worker-without-api', withoutApiURL, /api-unconfigured\.spec\.ts/),
  )
}
if (apiUnreachableURL) {
  projects.push(
    project(
      'worker-api-unreachable',
      apiUnreachableURL,
      /api-unreachable\.spec\.ts/,
    ),
  )
}
if (projects.length === 0) {
  throw new Error('WORKER_URL is not set; run ./bin/mise run e2e')
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

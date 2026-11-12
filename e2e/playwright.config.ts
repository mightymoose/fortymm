import { defineConfig, devices, type Project } from '@playwright/test'

// The cross-app suite: what can fail only because of how the apps are served
// or connected, such as the hosting in front of the web client. Anything one
// app can prove by itself belongs in that app's own validate. Run it with
// ./bin/mise run e2e.
//
// Two projects, one per thing that serves the web client's production build
// (set by compose.dev.yaml; a project whose URL is empty is left out):
// - worker (WORKER_URL): the web client's production hosting, the Worker in
//   web-client/worker/, in the local Workers runtime (web-client-worker). Its
//   rules: tests/hosting*.spec.ts. ./bin/mise run web-client:hosting-check
//   runs this project alone against any address, such as a deployment.
// - api-wiring (STAND_IN_URL): web-client-hosting, an nginx stand-in that
//   forwards /api/* to the api, which the Worker can't do yet. Only the
//   tests that need the api: tests/health.spec.ts.
const workerURL = process.env.WORKER_URL
const standInURL = process.env.STAND_IN_URL

const projects: Project[] = []
if (workerURL) {
  // Every hosting check runs only once the address serves this checkout's
  // build (tests/hosting-serves-build.setup.ts).
  projects.push(
    project('worker-serves-build', workerURL, /hosting-serves-build\.setup\.ts/),
    {
      ...project('worker', workerURL, /hosting.*\.spec\.ts/),
      dependencies: ['worker-serves-build'],
    },
  )
}
if (standInURL) {
  projects.push(project('api-wiring', standInURL, /health\.spec\.ts/))
}
if (projects.length === 0) {
  throw new Error(
    'Neither WORKER_URL nor STAND_IN_URL is set; run ./bin/mise run e2e',
  )
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

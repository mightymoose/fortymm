import { defineConfig, devices, type Project } from '@playwright/test'

// The cross-app suite: what can fail only because of how the apps are served
// or connected, such as the hosting in front of the web client. Anything one
// app can prove by itself belongs in that app's own validate. Run it with
// ./bin/mise run e2e.
//
// Both projects drive the web client's production hosting, the Worker in
// web-client/worker/, with the api behind its proxy (WORKER_URL, set by
// compose.dev.yaml): in the stack, the local Workers runtime
// (web-client-worker) forwarding /api/* to api-release; or a pull request's
// preview, forwarding to that pull request's api.
// - worker: the hosting's rules (tests/hosting*.spec.ts).
// - api-wiring: the web client reaching the api through it
//   (tests/health.spec.ts), the one check of the proxy.
// ./bin/mise run web-client:hosting-check runs both against any address,
// such as a deployment.
const workerURL = process.env.WORKER_URL
if (!workerURL) {
  throw new Error('WORKER_URL is not set; run ./bin/mise run e2e')
}

// Every test against the address runs only once it serves this checkout's
// build (tests/hosting-serves-build.setup.ts).
const projects: Project[] = [
  project('worker-serves-build', workerURL, /hosting-serves-build\.setup\.ts/),
  {
    ...project('worker', workerURL, /hosting.*\.spec\.ts/),
    dependencies: ['worker-serves-build'],
  },
  {
    ...project('api-wiring', workerURL, /health\.spec\.ts/),
    dependencies: ['worker-serves-build'],
  },
]

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

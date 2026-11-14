import { test as base } from '@playwright/test'
import { type Build, deploy } from './deployment.ts'

export { expect } from '@playwright/test'

// The suite's `test`: every test starts with its file's build deployed,
// `current` unless the file says `test.use({ build: 'harness' })`, whatever
// the test before it left in .site. One server is shared, and a test may
// deploy another build (offline.spec.ts deploys `next`).
export const test = base.extend<{ build: Build; deployed: void }>({
  build: ['current', { option: true }],
  deployed: [
    async ({ build }, use) => {
      await deploy(build)
      await use()
    },
    { auto: true },
  ],
})

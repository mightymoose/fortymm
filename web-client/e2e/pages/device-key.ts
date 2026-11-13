import type { Page } from '@playwright/test'

// The device key harness page (../harness/device-key.html), in the "harness"
// deployment: each method calls the same-named function the page puts on
// window.deviceKeyHarness, in the page.
type Harness = {
  publicKey(): Promise<string>
  coreIds(): Promise<{ accountId: string; ownPlayerId: string }>
  signAndVerify(): Promise<{
    rawLength: number
    verifies: boolean
    verifiesOtherBytes: boolean
  }>
  keysKept(): Promise<number>
  keptPrivateKey(): Promise<{
    isCryptoKey: boolean
    type: string
    extractable: boolean
    exports: Record<string, string>
  }>
}

export const harnessPath = '/device-key.html'

export class DeviceKeyHarness {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  // Loads the page directly, as a tab does, and waits for its script.
  async open() {
    await this.page.goto(harnessPath)
    await this.page.waitForFunction(() => 'deviceKeyHarness' in window)
  }

  publicKey() {
    return this.call('publicKey')
  }

  coreIds() {
    return this.call('coreIds')
  }

  signAndVerify() {
    return this.call('signAndVerify')
  }

  // Two callers in this page asking at the same moment, before any key is
  // kept: the public key each one got.
  publicKeyTwiceAtOnce(): Promise<[string, string]> {
    return this.page.evaluate(() => {
      const { deviceKeyHarness } = window as unknown as {
        deviceKeyHarness: Harness
      }
      return Promise.all([
        deviceKeyHarness.publicKey(),
        deviceKeyHarness.publicKey(),
      ])
    })
  }

  keysKept() {
    return this.call('keysKept')
  }

  keptPrivateKey() {
    return this.call('keptPrivateKey')
  }

  private call<Name extends keyof Harness>(
    name: Name,
  ): ReturnType<Harness[Name]> {
    return this.page.evaluate(
      (name) =>
        (
          window as unknown as {
            deviceKeyHarness: Record<string, () => Promise<unknown>>
          }
        ).deviceKeyHarness[name](),
      name,
    ) as ReturnType<Harness[Name]>
  }
}

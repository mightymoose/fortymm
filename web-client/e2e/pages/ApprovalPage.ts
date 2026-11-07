import type { Locator, Page } from '@playwright/test'

// Page object for the page a result link opens, on one phone.
export class ApprovalPage {
  readonly page: Page
  readonly heading: Locator
  readonly approveButton: Locator
  readonly editScores: Locator
  readonly signIn: Locator
  readonly main: Locator
  // The alert that says FortyMM didn't accept the approved result.
  readonly refusal: Locator

  constructor(page: Page) {
    this.page = page
    this.heading = page.getByRole('heading', { level: 1 })
    this.approveButton = page.getByRole('button', { name: 'Approve result' })
    this.editScores = page.getByRole('link', { name: 'Edit scores' })
    this.signIn = page.getByRole('link', { name: 'Sign in' })
    this.main = page.getByRole('main')
    this.refusal = page.getByRole('alert').filter({ hasText: 'FortyMM didn’t accept this result' })
  }

  // Opens `link` and waits until the page has decided what to show.
  async open(link: string): Promise<void> {
    await this.page.goto(link)
    await this.heading.waitFor()
  }

  status(text: string | RegExp): Locator {
    return this.page.getByRole('status').filter({ hasText: text })
  }

  // The link the page shows now, its path and its fragment, so an
  // approval's link holds both signatures.
  get link(): string {
    const { pathname, hash } = new URL(this.page.url())
    return `${pathname}${hash}`
  }
}

// `link` with one byte of its envelope changed by `change`, which gets the
// envelope's bytes and returns the index to change and its new value.
export function tamper(link: string, change: (bytes: Buffer) => [number, number]): string {
  const [path, hash] = link.split('#')
  const bytes = Buffer.from(hash, 'base64url')
  const [index, value] = change(bytes)
  bytes[index] = value
  return `${path}#${bytes.toString('base64url')}`
}

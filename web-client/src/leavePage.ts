// Full-page actions, in one module, because jsdom's `location` can't be
// spied on. Tests `vi.mock('../leavePage')` and get both.

export function leavePage(url: string): void {
  window.location.assign(url)
}

export function reloadPage(): void {
  window.location.reload()
}

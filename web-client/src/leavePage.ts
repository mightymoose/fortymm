// Leaves the app for `url` with a full page load. Tests mock this module,
// because jsdom's `location.assign` can't be spied on.
export function leavePage(url: string): void {
  window.location.assign(url)
}

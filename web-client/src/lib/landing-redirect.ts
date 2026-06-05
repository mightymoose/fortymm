export const APP_ENTERED_KEY = 'fortymm.app-entered'

export function markAppEntered(): void {
  try {
    window.localStorage.setItem(APP_ENTERED_KEY, '1')
  } catch {
    // Safari private mode / disabled storage — best-effort, the redirect
    // simply won't fire and the user sees the landing page next time.
  }
}

export function hasAppEntered(): boolean {
  try {
    return window.localStorage.getItem(APP_ENTERED_KEY) === '1'
  } catch {
    return false
  }
}

export function clearAppEntered(): void {
  try {
    window.localStorage.removeItem(APP_ENTERED_KEY)
  } catch {
    // Best-effort — see markAppEntered.
  }
}

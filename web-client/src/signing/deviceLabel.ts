// The label of this device in the account's device list, such as "Firefox
// on Android". The first match in each table wins, so Edge comes before
// Chrome, whose name Edge's user agent also carries.
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\b(OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(Firefox|FxiOS)\//, 'Firefox'],
  [/\b(Chrome|Chromium|CriOS)\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
]

const SYSTEMS: [RegExp, string][] = [
  [/\biPad\b/, 'iPadOS'],
  [/\b(iPhone|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b/, 'macOS'],
  [/\bWindows\b/, 'Windows'],
  [/\blinux\b/i, 'Linux'],
]

export function deviceLabel(userAgent: string): string {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1]
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1]
  if (browser && system) return `${browser} on ${system}`
  return browser ?? (system ? `Browser on ${system}` : 'Web browser')
}

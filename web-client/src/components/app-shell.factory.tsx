import type { AppShellProps } from './app-shell'

/**
 * Props for `AppShell` — the authenticated chrome wrapped around one page's
 * content. The shell takes nothing but its children; the interesting input is
 * the router's pathname (see `app-shell.page.tsx`), not a prop.
 */
export function buildAppShellProps(
  overrides: Partial<AppShellProps> = {},
): AppShellProps {
  return { children: <div>Page content</div>, ...overrides }
}

import type { DashboardHeaderProps } from './dashboard-header'
import type { DashboardHeaderView } from './dashboard-header/dashboard-header-view'

/** A signed-in header greeting rita.kovac. */
export function buildDashboardHeaderView(
  overrides: Partial<DashboardHeaderView> = {},
): DashboardHeaderView {
  return { greeting: 'Hi, @rita.kovac', ...overrides }
}

/** Props for `DashboardHeader` — the roomy (non-compact) layout by default. */
export function buildDashboardHeaderProps(
  overrides: Partial<DashboardHeaderProps> = {},
): DashboardHeaderProps {
  return { view: buildDashboardHeaderView(), compact: false, ...overrides }
}

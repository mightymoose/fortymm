/** The dashboard page header's derived copy. */
export interface DashboardHeaderView {
  /** Greeting headline — `Hi, @<username>` when signed in, else a bare `Hi`. */
  greeting: string
}

/**
 * Derive the header greeting from the current username. A session that hasn't
 * resolved yet (or an anonymous viewer) has no username, so it falls back to a
 * bare `Hi` rather than rendering a dangling `@`.
 */
export function projectDashboardHeaderView(
  username: string | undefined,
): DashboardHeaderView {
  return { greeting: username ? `Hi, @${username}` : 'Hi' }
}

import { createMemoryHistory } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { App } from './App.tsx'
import { AdminScreenPage } from './components/AdminScreen.page.tsx'
import { AppLayoutPage } from './components/AppLayout.page.tsx'
import { DashboardScreenPage } from './components/DashboardScreen.page.tsx'
import { DesignSystemContainersScreenPage } from './components/design-system/DesignSystemContainersScreen.page.tsx'
import { DesignSystemFormsScreenPage } from './components/design-system/DesignSystemFormsScreen.page.tsx'
import { DesignSystemMainScreenPage } from './components/design-system/DesignSystemMainScreen.page.tsx'
import { DesignSystemMatchScreenPage } from './components/design-system/DesignSystemMatchScreen.page.tsx'
import { DesignSystemMoreScreenPage } from './components/design-system/DesignSystemMoreScreen.page.tsx'
import { DesignSystemOverlaysScreenPage } from './components/design-system/DesignSystemOverlaysScreen.page.tsx'
import { DesignSystemRolesScreenPage } from './components/design-system/DesignSystemRolesScreen.page.tsx'
import { DesignSystemStatesScreenPage } from './components/design-system/DesignSystemStatesScreen.page.tsx'
import { HealthScreenPage } from './components/HealthScreen.page.tsx'
import { MatchesScreenPage } from './components/MatchesScreen.page.tsx'
import { NewMatchScreenPage } from './components/NewMatchScreen.page.tsx'
import { NotFoundScreenPage } from './components/NotFoundScreen.page.tsx'
import { SettingsScreenPage } from './components/SettingsScreen.page.tsx'
import { UsersScreenPage } from './components/UsersScreen.page.tsx'
import { createAppRouter } from './router.ts'
import { createTestQueryClient } from './testQueryClient.ts'

// Page object for the whole app, rendered with an in-memory history so a test can start at any path.
// The api is MSW's (see src/mocks/).
export class AppPage {
  readonly layout = new AppLayoutPage()
  readonly dashboard = new DashboardScreenPage()
  readonly matches = new MatchesScreenPage()
  readonly newMatch = new NewMatchScreenPage()
  readonly users = new UsersScreenPage()
  readonly admin = new AdminScreenPage()
  readonly settings = new SettingsScreenPage()
  readonly health = new HealthScreenPage()
  readonly notFound = new NotFoundScreenPage()
  readonly designSystem = {
    main: new DesignSystemMainScreenPage(),
    roles: new DesignSystemRolesScreenPage(),
    forms: new DesignSystemFormsScreenPage(),
    containers: new DesignSystemContainersScreenPage(),
    overlays: new DesignSystemOverlaysScreenPage(),
    match: new DesignSystemMatchScreenPage(),
    more: new DesignSystemMoreScreenPage(),
    states: new DesignSystemStatesScreenPage(),
  }

  // Resolves once the router has loaded the route at `path`, so its screen is already on the page.
  static async render(path = '/') {
    const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) })
    await router.load()
    render(<App router={router} queryClient={createTestQueryClient()} />)
    return new AppPage()
  }
}

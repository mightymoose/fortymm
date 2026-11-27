import { type Page } from '@playwright/test'
import { ContainersAppPage } from './containers/containers.app.page.ts'
import { type ContainersBoard } from './containers/containers.board.ts'
import { ContainersReferencePage } from './containers/containers.reference.page.ts'
import { FormsAppPage } from './forms/forms.app.page.ts'
import { type FormsBoard } from './forms/forms.board.ts'
import { FormsReferencePage } from './forms/forms.reference.page.ts'
import { MainAppPage } from './main/main.app.page.ts'
import { type MainBoard } from './main/main.board.ts'
import { MainReferencePage } from './main/main.reference.page.ts'
import { MatchAppPage } from './match/match.app.page.ts'
import { type MatchBoard } from './match/match.board.ts'
import { MatchReferencePage } from './match/match.reference.page.ts'
import { MoreAppPage } from './more/more.app.page.ts'
import { type MoreBoard } from './more/more.board.ts'
import { MoreReferencePage } from './more/more.reference.page.ts'
import { OverlaysAppPage } from './overlays/overlays.app.page.ts'
import { type OverlaysBoard } from './overlays/overlays.board.ts'
import { OverlaysReferencePage } from './overlays/overlays.reference.page.ts'
import { RolesAppPage } from './roles/roles.app.page.ts'
import { type RolesBoard } from './roles/roles.board.ts'
import { RolesReferencePage } from './roles/roles.reference.page.ts'
import { StatesAppPage } from './states/states.app.page.ts'
import { type StatesBoard } from './states/states.board.ts'
import { StatesReferencePage } from './states/states.reference.page.ts'

// Every board, as page objects for one target: the reference or the app. The design system specs
// run once per target, so the app is checked with the same tests as the reference.
export interface Boards {
  main: MainBoard
  roles: RolesBoard
  forms: FormsBoard
  containers: ContainersBoard
  overlays: OverlaysBoard
  match: MatchBoard
  more: MoreBoard
  states: StatesBoard
}

export const targets: { name: string; boards: (page: Page) => Boards }[] = [
  {
    name: 'reference',
    boards: (page) => ({
      main: new MainReferencePage(page),
      roles: new RolesReferencePage(page),
      forms: new FormsReferencePage(page),
      containers: new ContainersReferencePage(page),
      overlays: new OverlaysReferencePage(page),
      match: new MatchReferencePage(page),
      more: new MoreReferencePage(page),
      states: new StatesReferencePage(page),
    }),
  },
  {
    name: 'app',
    boards: (page) => ({
      main: new MainAppPage(page),
      roles: new RolesAppPage(page),
      forms: new FormsAppPage(page),
      containers: new ContainersAppPage(page),
      overlays: new OverlaysAppPage(page),
      match: new MatchAppPage(page),
      more: new MoreAppPage(page),
      states: new StatesAppPage(page),
    }),
  },
]

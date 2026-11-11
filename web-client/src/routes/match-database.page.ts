import { screen, within } from '@testing-library/react'
import { renderRoute } from '../test/render-route.tsx'

// The match database screen (src/routes/match-database.tsx): how to open it,
// and what a person sees on it. Say how the api answers first (server.use
// with a handler from src/test/api/match-database.ts), then render().
export class MatchDatabasePage {
  render() {
    return renderRoute('/match-database')
  }

  heading() {
    return screen.findByRole('heading', { name: 'Match database' })
  }

  database() {
    return screen.findByRole('textbox', { name: 'Database' })
  }

  sideOne() {
    return screen.findByRole('textbox', { name: 'Side one players' })
  }

  makeParcel() {
    return screen.findByRole('button', { name: 'Make a match parcel' })
  }

  parcel(number: number) {
    return screen.findByRole('textbox', { name: `Parcel ${number}` })
  }

  async parcels() {
    return within(await screen.findByRole('list', { name: 'Parcels' })).queryAllByRole(
      'textbox',
    )
  }

  addParcelToPaste() {
    return screen.findByRole('button', { name: 'Add a parcel to paste' })
  }

  apply() {
    return screen.findByRole('button', { name: 'Apply the parcels' })
  }

  outcomes() {
    return screen.findByRole('list', { name: 'What happened to each parcel' })
  }

  newDatabase() {
    return screen.findByRole('textbox', { name: 'New database' })
  }

  useNewDatabase() {
    return screen.findByRole('button', { name: 'Use the new database' })
  }

  alert() {
    return screen.findByRole('alert')
  }
}

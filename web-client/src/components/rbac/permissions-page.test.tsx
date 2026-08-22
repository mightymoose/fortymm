import { permissionsPage } from './permissions-page.page'
import { CAFE_PERMISSION_NAME } from './permissions-page.factory'

// The permission *name* is ASCII by pattern (`PERMISSION_NAME_PATTERN`), so the
// description is the only field here a diacritic can reach. `toLowerCase()`
// folds case and never folds accents, so an admin on an ASCII keyboard could
// not find that row at all.
describe('PermissionsPage — search', () => {
  it('matches a permission by name', async () => {
    permissionsPage.render()

    await permissionsPage.search('tournament.view')

    expect(await permissionsPage.findPermissionRow('tournament.view')).toBeInTheDocument()
    expect(permissionsPage.queryPermissionRow('tournament.create')).toBeNull()
  })

  it('matches a permission by description', async () => {
    permissionsPage.render()

    await permissionsPage.search('Spin up')

    expect(await permissionsPage.findPermissionRow('tournament.create')).toBeInTheDocument()
    expect(permissionsPage.queryPermissionRow('tournament.view')).toBeNull()
  })

  it('finds an accented description from unaccented text', async () => {
    permissionsPage.render()

    await permissionsPage.search('cafe')

    expect(await permissionsPage.findPermissionRow(CAFE_PERMISSION_NAME)).toBeInTheDocument()
    expect(permissionsPage.queryPermissionRow('tournament.view')).toBeNull()
  })

  it('still finds it when the accent is typed, so the fold widens both ways', async () => {
    permissionsPage.render()

    await permissionsPage.search('café')

    expect(await permissionsPage.findPermissionRow(CAFE_PERMISSION_NAME)).toBeInTheDocument()
  })

  it('still reports no match for text nothing carries', async () => {
    permissionsPage.render()

    await permissionsPage.search('zzzznothing')

    expect(await permissionsPage.findSearch()).toHaveValue('zzzznothing')
    expect(permissionsPage.queryPermissionRows()).toHaveLength(0)
    expect(permissionsPage.queryNoMatches()).toBeInTheDocument()
  })
})

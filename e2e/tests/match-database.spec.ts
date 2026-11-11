import { expect, test } from '@playwright/test'
import { MatchDatabasePage } from '../pages/match-database-page.ts'

// The wire between the hosted web client, the core's WebAssembly build and the
// api's production image. The page can only say the parcel's record is held
// if the hosting served the WebAssembly file and the bundle loaded it, the
// browser signed with WebCrypto, the hosting forwarded the submit to the api,
// and the api's image read the parcel with the core's Python module. What
// each answer looks like is proven in web-client's component tests; every
// case of applying a parcel, in api/tests/.
test('a match parcel made and signed in the hosted page comes back from the api as a held match', async ({
  page,
}) => {
  const pageErrors: Error[] = []
  page.on('pageerror', (error) => pageErrors.push(error))
  const screen = new MatchDatabasePage(page)

  await screen.open()
  await screen.makeParcel.click()
  await expect(screen.parcel(1)).not.toHaveValue('')
  await screen.apply.click()

  await expect(screen.outcomes).toContainText('Parcel 1: applied')
  await expect(screen.outcomes).toContainText(/Record [0-9a-f]{64}: held/)
  await expect(screen.newDatabase).toHaveValue(/"matches": \[\s*\{\s*"match_id"/)
  expect(pageErrors).toEqual([])
})

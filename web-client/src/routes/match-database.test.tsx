import { userEvent } from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { loadCore } from '../core/load.ts'
import { applies, NEW_DATABASE, refusesTheDatabase } from '../test/api/match-database.ts'
import { server } from '../test/api/server.ts'
import { MatchDatabasePage } from './match-database.page.ts'

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

test('the database starts empty, as {}', async () => {
  const page = new MatchDatabasePage()
  await page.render()

  expect(await page.heading()).toBeVisible()
  expect(await page.database()).toHaveValue('{}')
})

test('the form holds several parcels made and signed in the browser, and sends them all in one submit', async () => {
  const { handler, requests } = applies()
  server.use(handler)
  const user = userEvent.setup()
  const page = new MatchDatabasePage()
  await page.render()

  await user.click(await page.makeParcel())
  await user.click(await page.makeParcel())
  await page.parcel(2)
  await user.click(await page.apply())
  await page.outcomes()

  expect(requests).toHaveLength(1)
  const { database, parcels, arrived_at } = requests[0]
  expect(database).toEqual({})
  expect(parcels).toHaveLength(2)
  expect(Number.isNaN(Date.parse(arrived_at))).toBe(false)
  // Each is a parcel of one record that verifies: made and signed here.
  const core = await loadCore()
  const records = await Promise.all(
    parcels.map(async (text) => {
      const [record] = core.records(core.parse(text))
      expect(await core.verify(record)).toBe(true)
      return hex(await core.id(record))
    }),
  )
  expect(new Set(records).size).toBe(2)
})

test('after a submit, the form shows what happened to each parcel and the new database', async () => {
  server.use(applies().handler)
  const user = userEvent.setup()
  const page = new MatchDatabasePage()
  await page.render()

  await user.click(await page.makeParcel())
  await user.click(await page.addParcelToPaste())
  await user.type(await page.parcel(2), 'NOT A PARCEL')
  await user.click(await page.apply())

  const outcomes = await page.outcomes()
  expect(outcomes).toHaveTextContent(`Parcel 1: applied`)
  expect(outcomes).toHaveTextContent(`Record ${'bb'.repeat(32)}: held`)
  expect(outcomes).toHaveTextContent('Parcel 2: refused (damaged)')
  expect(await page.newDatabase()).toHaveValue(JSON.stringify(NEW_DATABASE, null, 2))
})

test('the form carries the new database into the next submit', async () => {
  const { handler, requests } = applies()
  server.use(handler)
  const user = userEvent.setup()
  const page = new MatchDatabasePage()
  await page.render()

  await user.click(await page.makeParcel())
  await user.click(await page.apply())
  await user.click(await page.useNewDatabase())
  await user.click(await page.apply())

  await expect.poll(() => requests.length).toBe(2)
  expect(requests[1].database).toEqual(NEW_DATABASE)
})

test('when the api refuses a submit, the form says where and keeps what was typed', async () => {
  const { handler, requests } = refusesTheDatabase()
  server.use(handler)
  const user = userEvent.setup()
  const page = new MatchDatabasePage()
  await page.render()

  await user.clear(await page.database())
  await user.type(await page.database(), '5')
  await user.click(await page.makeParcel())
  const parcel = ((await page.parcel(1)) as HTMLTextAreaElement).value
  await user.click(await page.apply())

  expect(await page.alert()).toHaveTextContent('the part at “/database” is not valid')
  expect(requests).toHaveLength(1)
  expect(await page.database()).toHaveValue('5')
  expect(await page.parcel(1)).toHaveValue(parcel)
})

test('a database that is not JSON is not sent, and stays as typed', async () => {
  const page = new MatchDatabasePage()
  const user = userEvent.setup()
  await page.render()

  await user.clear(await page.database())
  await user.type(await page.database(), 'not json')
  await user.click(await page.makeParcel())
  await user.click(await page.apply())

  // No handler: a request would fail the test (src/test/setup.ts).
  expect(await page.alert()).toHaveTextContent('The database is not JSON')
  expect(await page.database()).toHaveValue('not json')
})

test('a player id that is not 64 hex digits makes no parcel', async () => {
  const page = new MatchDatabasePage()
  const user = userEvent.setup()
  await page.render()

  await user.clear(await page.sideOne())
  await user.type(await page.sideOne(), 'abc')
  await user.click(await page.makeParcel())

  expect(await page.alert()).toHaveTextContent('64 hex digits')
  expect(await page.parcels()).toHaveLength(0)
})

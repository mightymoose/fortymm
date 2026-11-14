import { expect, test } from 'vitest'
import { createQueue } from './queue.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

test('a job asked for while another runs starts only once that one has settled', async () => {
  const queue = createQueue()
  const events: string[] = []
  const first = deferred()

  const one = queue(async () => {
    events.push('first starts')
    await first.promise
    events.push('first ends')
  })
  const two = queue(async () => {
    events.push('second starts')
  })
  await Promise.resolve()
  expect(events).toEqual(['first starts'])

  first.resolve()
  await Promise.all([one, two])
  expect(events).toEqual(['first starts', 'first ends', 'second starts'])
})

test('a job that fails gives its caller the failure and the next job still runs', async () => {
  const queue = createQueue()

  const failed = queue(() => Promise.reject(new Error('Refused')))
  const next = queue(async () => 'ran')

  await expect(failed).rejects.toThrow('Refused')
  expect(await next).toBe('ran')
})

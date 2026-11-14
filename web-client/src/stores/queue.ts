// One queue per store: every job that sets the store's state runs on one
// promise chain, one at a time, in the order they were asked for. A reload
// that began before a write can therefore never land after it. A job that
// fails gives its caller the failure and doesn't stop the jobs after it.
export type Queue = <T>(job: () => Promise<T>) => Promise<T>

export function createQueue(): Queue {
  let last: Promise<unknown> = Promise.resolve()
  return (job) => {
    const run = last.then(job)
    last = run.catch(() => {})
    return run
  }
}

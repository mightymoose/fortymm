import { createFileRoute, Link } from '@tanstack/react-router'
import { startupLaunchSettled } from '../first-launch.ts'
import { loadMe, type LoadUserResult, type User } from '../storage.ts'

// /settings: this device's account, as stored on the device (src/storage.ts).
// It reads this device's user with loadMe, one read: no key, no core. On a
// device whose first launch is still running (a first visit straight to this
// page), no user is marked yet: the loader then waits for that launch, up to
// its bound (startupLaunchSettled), and reads again. Opening the page reads
// only: with no user, it says there is no account yet, and makes nothing.
// Every outcome is data the page shows; the loader never throws.
export const Route = createFileRoute('/settings')({
  loader: () => ownAccount(),
  pendingComponent: Reading,
  component: SettingsPage,
})

type Account =
  | { state: 'user'; user: User }
  | { state: 'none' }
  | { state: 'storage-unavailable' }

async function ownAccount(): Promise<Account> {
  const first = await loadMe()
  if (first.ok && first.user === null) {
    await startupLaunchSettled()
    return accountOf(await loadMe())
  }
  return accountOf(first)
}

function accountOf(loaded: LoadUserResult): Account {
  if (!loaded.ok) return { state: 'storage-unavailable' }
  return loaded.user === null ? { state: 'none' } : { state: 'user', user: loaded.user }
}

function Reading() {
  return (
    <section id="center">
      <h1>Account settings</h1>
      <h2>Reading this device’s account</h2>
    </section>
  )
}

function SettingsPage() {
  const account = Route.useLoaderData()
  return (
    <section id="center">
      <div>
        <h1>Account settings</h1>
        <AccountAnswer account={account} />
      </div>
      <Link to="/">Go to the start page</Link>
    </section>
  )
}

function AccountAnswer({ account }: { account: Account }) {
  switch (account.state) {
    case 'user':
      return <Account user={account.user} />
    case 'none':
      return (
        <>
          <h2>No account yet</h2>
          <p>This device has no account yet.</p>
        </>
      )
    case 'storage-unavailable':
      return (
        <>
          <h2>Can’t read this device’s storage</h2>
          <p>The browser refused to open the storage where the account is kept.</p>
        </>
      )
  }
}

// The username only (the user's choice), in a region named by its heading.
function Account({ user }: { user: User }) {
  return (
    <section aria-labelledby="username">
      <h2 id="username">Username</h2>
      <p>{user.username}</p>
    </section>
  )
}

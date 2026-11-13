import { createFileRoute, Link } from '@tanstack/react-router'
import { loadCore } from '../core/load.ts'
import { keptPublicKey } from '../device-key.ts'
import { loadUser, type User } from '../storage.ts'

// /settings: this device's account, as stored on the device (src/storage.ts).
// This device's user is the one whose player id the core gives for the
// device's kept key (ownPlayerId). Opening the page reads only: with no key
// kept, or no user stored for it, it says there is no account yet, and makes
// neither. Every outcome is data the page shows; the loader never throws.
export const Route = createFileRoute('/settings')({
  loader: () => ownAccount(),
  pendingComponent: Reading,
  component: SettingsPage,
})

type Account =
  | { state: 'user'; user: User }
  | { state: 'none' }
  | { state: 'storage-unavailable' }
  | { state: 'core-unavailable' }

async function ownAccount(): Promise<Account> {
  const kept = await keptPublicKey()
  if (!kept.ok) return { state: 'storage-unavailable' }
  if (kept.publicKey === null) return { state: 'none' }
  let playerId: string
  try {
    const core = await loadCore()
    playerId = hex(core.ownPlayerId(kept.publicKey))
  } catch {
    return { state: 'core-unavailable' }
  }
  const loaded = await loadUser(playerId)
  if (!loaded.ok) return { state: 'storage-unavailable' }
  return loaded.user === null ? { state: 'none' } : { state: 'user', user: loaded.user }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
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
    case 'core-unavailable':
      return (
        <>
          <h2>The shared core did not load</h2>
          <p>This device could not load it, so it can’t tell which account is its own.</p>
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

import type { User } from '../../storage.ts'
import type { Account } from '../../stores/user.ts'

// The account settings page, at /settings: this device's account, as the
// user store read it (src/stores/user.ts), handed over by Settings.tsx. It
// shows what it is given and makes nothing.
export function SettingsScreen({ account }: { account: Account }) {
  return (
    <section id="center">
      <div>
        <h1>Account settings</h1>
        <AccountAnswer account={account} />
      </div>
    </section>
  )
}

// What the page shows while the account is still being read.
export function SettingsScreenPending() {
  return (
    <section id="center">
      <h1>Account settings</h1>
      <h2>Reading this device’s account</h2>
    </section>
  )
}

function AccountAnswer({ account }: { account: Account }) {
  switch (account.state) {
    case 'user':
      return <Username user={account.user} />
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
function Username({ user }: { user: User }) {
  return (
    <section aria-labelledby="username">
      <h2 id="username">Username</h2>
      <p>{user.username}</p>
    </section>
  )
}

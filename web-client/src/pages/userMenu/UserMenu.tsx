import { useQuery } from '@tanstack/react-query'
import { useRouteContext, useSearch } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import type { components } from '../../api/schema'
import { sessionQuery } from '../../api/queries'
import { Button } from '../../components/Button'
import { closeDialog } from '../../components/closeDialog'
import { Dialog } from '../../components/Dialog'
import { DetailList } from '../../components/DetailList'
import { Icon } from '../../components/Icon'
import { PlayerAvatar } from '../../components/PlayerAvatar'
import { Sheet } from '../../components/Sheet'
import { useSignInHref } from '../useSignInHref'
import { useSignOut } from '../useSignOut'
import { parseUserMenuDesign, type UserMenuDesign } from './userMenuDesigns'

type Account = components['schemas']['SessionAccount']

// The name the menu shows: the player's display name, or the email of a
// verified account with no player.
function nameOf(account: Account): string {
  return account.player?.display_name ?? account.email ?? ''
}

// The line under the name: the email of a verified account, or that the
// visitor plays as a guest.
function detailOf(account: Account): string {
  return account.kind === 'guest' ? 'Playing as a guest' : (account.email ?? '')
}

// The visitor's account at the topbar's right end, styled by `.user-menu`
// in styles/base.css. The avatar opens it. A guest gets Sign in, and a
// verified account gets Sign out. `?menu=` picks the design under review.
// It shows nothing until the session has started, and it doesn't suspend,
// so the loading screen times only the page.
export function UserMenu() {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useQuery(sessionQuery(api))
  const search: { menu?: unknown } = useSearch({ strict: false })
  if (!account) return null
  return <Design design={parseUserMenuDesign(search.menu)} account={account} />
}

function Design({ design, account }: { design: UserMenuDesign; account: Account }) {
  switch (design) {
    case 'menu':
      return <DropdownMenu account={account} />
    case 'chip':
      return <DropdownMenu account={account} chip />
    case 'card':
      return <CardPopover account={account} />
    case 'sheet':
      return <AccountSheet account={account} />
    case 'confirm':
      return <DropdownMenu account={account} confirm />
  }
}

// The avatar that opens the menu. As a `chip`, it also shows the name. It
// has no tooltip, because the menu it opens names the account.
function Trigger({
  account,
  chip = false,
  popup,
  open,
  controls,
  onClick,
  ref,
}: {
  account: Account
  chip?: boolean
  popup: 'menu' | 'dialog'
  open: boolean
  controls: string
  onClick: () => void
  ref?: Ref<HTMLButtonElement>
}) {
  const name = nameOf(account)
  return (
    <button
      type="button"
      ref={ref}
      className={chip ? 'user-menu__trigger user-menu__trigger--chip' : 'user-menu__trigger'}
      aria-label="Your account"
      aria-haspopup={popup}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onClick}
    >
      <PlayerAvatar name={name} />
      {chip && (
        <>
          <span className="user-menu__chip-name">{name}</span>
          <Icon name="chevron" />
        </>
      )}
    </button>
  )
}

// Open state for a popover under the trigger. A press outside or Esc closes
// it, and Esc puts focus back on the trigger.
function usePopover() {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return
    setOpen(false)
    trigger.current?.focus()
  }

  return { open, setOpen, root, trigger, onKeyDown }
}

// A dropdown of the `fm-menu` kind: the account's name and detail, then
// Sign in or Sign out. As a `chip`, the trigger shows the name. With
// `confirm`, Sign out asks first.
function DropdownMenu({
  account,
  chip = false,
  confirm = false,
}: {
  account: Account
  chip?: boolean
  confirm?: boolean
}) {
  const id = useId()
  const { open, setOpen, root, trigger, onKeyDown } = usePopover()
  const list = useRef<HTMLDivElement>(null)
  const confirmDialog = useRef<HTMLDialogElement>(null)
  const signInHref = useSignInHref()
  const { signOut, leaving, failed } = useSignOut()

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
  }, [open])

  const onListKeyDown = (event: KeyboardEvent) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const moves: Record<string, number> = {
      ArrowDown: at + 1,
      ArrowUp: at - 1,
      Home: 0,
      End: items.length - 1,
    }
    if (!(event.key in moves)) return
    event.preventDefault()
    items[(moves[event.key] + items.length) % items.length]?.focus()
  }

  return (
    <div className="user-menu" ref={root} onKeyDown={onKeyDown}>
      <Trigger
        account={account}
        chip={chip}
        popup="menu"
        open={open}
        controls={id}
        ref={trigger}
        onClick={() => setOpen(!open)}
      />
      <div
        className="fm-overlay fm-menu user-menu__popup"
        role="menu"
        aria-label="Your account"
        id={id}
        hidden={!open}
        ref={list}
        onKeyDown={onListKeyDown}
      >
        <div className="user-menu__head">
          {!chip && <b>{nameOf(account)}</b>}
          <span>{detailOf(account)}</span>
        </div>
        <hr />
        {failed && (
          <p className="user-menu__error" role="alert">
            Couldn’t sign you out. Check your connection, then try again.
          </p>
        )}
        {account.kind === 'guest' ? (
          <a className="fm-menu__item" role="menuitem" href={signInHref}>
            Sign in
          </a>
        ) : (
          <button
            type="button"
            className="fm-menu__item"
            role="menuitem"
            aria-disabled={leaving || undefined}
            onClick={() => {
              if (leaving) return
              if (confirm) confirmDialog.current?.showModal()
              else signOut()
            }}
          >
            {leaving ? 'Signing out…' : 'Sign out'}
          </button>
        )}
      </div>
      {confirm && (
        <Dialog
          ref={confirmDialog}
          title="Sign out of FortyMM?"
          actions={
            <>
              <Button variant="secondary" onClick={closeDialog}>
                Stay signed in
              </Button>
              <Button variant="primary" busy={leaving} onClick={signOut}>
                Sign out
              </Button>
            </>
          }
        >
          <p>To use this account again on this device, sign in with {account.email}.</p>
        </Dialog>
      )}
    </div>
  )
}

// A card under the avatar: a large avatar, the name and detail, then one
// full-width button.
function CardPopover({ account }: { account: Account }) {
  const id = useId()
  const titleId = useId()
  const { open, setOpen, root, trigger, onKeyDown } = usePopover()
  const name = nameOf(account)

  return (
    <div className="user-menu" ref={root} onKeyDown={onKeyDown}>
      <Trigger
        account={account}
        popup="dialog"
        open={open}
        controls={id}
        ref={trigger}
        onClick={() => setOpen(!open)}
      />
      <div
        className="fm-overlay user-menu__popup user-menu__card"
        role="dialog"
        aria-labelledby={titleId}
        id={id}
        hidden={!open}
      >
        <PlayerAvatar name={name} className="user-menu__card-avatar" />
        <div className="user-menu__head user-menu__head--center">
          <b id={titleId}>{name}</b>
          <span>{detailOf(account)}</span>
        </div>
        <AccountAction account={account} block />
      </div>
    </div>
  )
}

// A drawer from the right with the account's details, and the action in
// its footer.
function AccountSheet({ account }: { account: Account }) {
  const sheet = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false)
  const id = useId()

  return (
    <div className="user-menu">
      <Trigger
        account={account}
        popup="dialog"
        open={open}
        controls={id}
        onClick={() => {
          sheet.current?.showModal()
          setOpen(true)
        }}
      />
      <Sheet
        ref={sheet}
        id={id}
        title="Your account"
        subtitle={detailOf(account)}
        onClose={() => setOpen(false)}
        footer={<AccountAction account={account} />}
      >
        <DetailList
          details={[
            { term: 'Player', value: account.player?.display_name ?? 'None yet' },
            { term: 'Account', value: account.kind === 'guest' ? 'Guest' : 'Signed in' },
            ...(account.email ? [{ term: 'Email', value: account.email }] : []),
          ]}
        />
      </Sheet>
    </div>
  )
}

// Sign in for a guest, Sign out for a verified account, as a button. With
// `block`, it fills its container's width.
function AccountAction({ account, block = false }: { account: Account; block?: boolean }) {
  const signInHref = useSignInHref()
  const { signOut, leaving, failed } = useSignOut()
  const className = block ? 'user-menu__block' : undefined

  if (account.kind === 'guest') {
    return (
      <a
        className={`fm-btn fm-btn--primary${block ? ' user-menu__block' : ''}`}
        href={signInHref}
      >
        Sign in
      </a>
    )
  }
  return (
    <div className="user-menu__stack">
      {failed && (
        <p className="user-menu__error" role="alert">
          Couldn’t sign you out. Check your connection, then try again.
        </p>
      )}
      <Button
        variant="secondary"
        className={className}
        busy={leaving}
        aria-disabled={leaving || undefined}
        onClick={signOut}
      >
        {leaving ? 'Signing out…' : 'Sign out'}
      </Button>
    </div>
  )
}

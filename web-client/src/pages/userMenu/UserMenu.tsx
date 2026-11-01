import { useQuery } from '@tanstack/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { can, Permission } from '../../api/permissions'
import { sessionQuery } from '../../api/queries'
import { Button } from '../../components/Button'
import { closeDialog } from '../../components/closeDialog'
import { Dialog } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { PlayerAvatar } from '../../components/PlayerAvatar'
import { mobileApps } from '../../mobileApps'
import { useSignInHref } from '../useSignInHref'
import { useSignOut } from '../useSignOut'
import { useNarrowLayout } from './useNarrowLayout'

// The visitor's account at the topbar's right end, styled by `.user-menu` in
// styles/base.css: a chip of the player's avatar and name that opens a menu.
// A guest gets Sign in, and Sign out behind a dialog, because nobody can get
// a guest account back after it signs out. A verified account signs out at
// once. An account with `admin.view` gets a link to the admin page. Below
// 900px, where the sidebar is a tab bar, it links to each mobile beta. It
// shows nothing until the session has started, and it doesn't
// suspend, so the loading screen times only the page.
export function UserMenu() {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useQuery(sessionQuery(api))
  const id = useId()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const guestDialog = useRef<HTMLDialogElement>(null)
  const signInHref = useSignInHref()
  const { signOut, leaving, failed } = useSignOut()
  const narrow = useNarrowLayout()

  useEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  if (!account) return null
  const name = account.player.display_name

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return
    setOpen(false)
    trigger.current?.focus()
  }

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
      <button
        type="button"
        ref={trigger}
        className="user-menu__trigger"
        aria-label="Your account"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <PlayerAvatar name={name} />
        <span className="user-menu__name">{name}</span>
        <Icon name="chevron" />
      </button>
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
          {account.kind === 'guest' ? 'Playing as a guest' : account.email}
        </div>
        <hr />
        {can(account, Permission.adminView) && (
          <Link
            to="/admin"
            className="fm-menu__item"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            Admin
          </Link>
        )}
        {narrow &&
          mobileApps.map((app) => (
            <a
              key={app.href}
              className="fm-menu__item"
              role="menuitem"
              href={app.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={app.name}
              onClick={() => setOpen(false)}
            >
              {app.label}
            </a>
          ))}
        {failed && (
          <p className="user-menu__error" role="alert">
            Couldn’t sign you out. Check your connection, then try again.
          </p>
        )}
        {account.kind === 'guest' && (
          // A full page load, because the API answers with a 302.
          <a className="fm-menu__item" role="menuitem" href={signInHref}>
            Sign in
          </a>
        )}
        <button
          type="button"
          className="fm-menu__item"
          role="menuitem"
          aria-disabled={leaving || undefined}
          onClick={() => {
            if (leaving) return
            if (account.kind !== 'guest') return signOut()
            setOpen(false)
            guestDialog.current?.showModal()
          }}
        >
          {leaving ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
      {account.kind === 'guest' && (
        <Dialog
          ref={guestDialog}
          // The menu item that opened it is hidden by then.
          onClose={() => trigger.current?.focus()}
          title="Sign out of this guest account?"
          actions={
            <>
              <Button variant="secondary" onClick={closeDialog}>
                Keep playing
              </Button>
              <Button variant="danger" busy={leaving} onClick={signOut}>
                Sign out
              </Button>
            </>
          }
        >
          <p>
            A guest account lives only in this browser. After you sign out, you
            can’t get it back, and {name} stays behind.{' '}
            <a href={signInHref}>Sign in</a> first to keep it.
          </p>
          {failed && (
            <p className="user-menu__error" role="alert">
              Couldn’t sign you out. Check your connection, then try again.
            </p>
          )}
        </Dialog>
      )}
    </div>
  )
}

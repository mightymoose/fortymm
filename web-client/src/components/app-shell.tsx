import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useLinkProps, useRouterState } from '@tanstack/react-router'
import {
  Bell,
  ChevronDown,
  Gauge,
  Inbox,
  Key,
  Megaphone,
  Shield,
  SlidersHorizontal,
  TriangleAlert,
  Trophy,
  Users,
} from 'lucide-react'
import { useSession } from '@/api/session'
import { Wordmark } from '@/components/wordmark'
import { cn } from '@/lib/utils'
import { PERM } from '@/lib/permissions'
import { NotificationBell } from './notifications/notification-bell'
import { UserMenu } from './user-menu'
import { Badge } from '@/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'

type NavChild = { label: string; to: string; icon: ReactNode; requires?: string }

type NavItem = {
  label: string
  icon: ReactNode
  to: string
  requires?: string
  children?: NavChild[]
}

type NavSection = {
  label?: string
  items: NavItem[]
}

const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      {
        label: 'Dashboard',
        to: '/dashboard',
        icon: (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="7" height="9" />
            <rect x="14" y="3" width="7" height="5" />
            <rect x="14" y="12" width="7" height="9" />
            <rect x="3" y="16" width="7" height="5" />
          </svg>
        ),
      },
      {
        label: 'Matches',
        to: '/matches',
        icon: (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
          </svg>
        ),
      },
      {
        label: 'Players',
        to: '/players',
        icon: <Users size={18} strokeWidth={2} />,
      },
      {
        // Top-level (not nested under Administration, which requires
        // ADMIN_VIEW) so a Beta tester with `tournament.view` sees it.
        label: 'Tournaments',
        to: '/tournaments',
        requires: PERM.TOURNAMENT_VIEW,
        icon: <Trophy size={18} strokeWidth={2} />,
      },
      {
        label: 'Notifications',
        to: '/notifications',
        icon: <Bell size={18} strokeWidth={2} />,
        children: [
          { label: 'Inbox', to: '/notifications', icon: <Inbox size={15} strokeWidth={1.75} /> },
          { label: 'Preferences', to: '/notifications/settings', icon: <SlidersHorizontal size={15} strokeWidth={1.75} /> },
        ],
      },
    ],
  },
  {
    items: [
      {
        label: 'Administration',
        to: '/admin',
        requires: PERM.ADMIN_VIEW,
        icon: (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2l9 4v6c0 5-3.5 9-9 10-5.5-1-9-5-9-10V6l9-4z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        ),
        children: [
          { label: 'Overview', to: '/admin', icon: <Gauge size={15} strokeWidth={1.75} /> },
          { label: 'Roles', to: '/admin/roles', icon: <Shield size={15} strokeWidth={1.75} />, requires: PERM.AUTH_MANAGE },
          { label: 'Permissions', to: '/admin/permissions', icon: <Key size={15} strokeWidth={1.75} />, requires: PERM.AUTH_MANAGE },
          { label: 'Users', to: '/admin/users', icon: <Users size={15} strokeWidth={1.75} />, requires: PERM.AUTH_MANAGE },
          { label: 'Broadcast', to: '/admin/broadcast', icon: <Megaphone size={15} strokeWidth={1.75} />, requires: PERM.NOTIFICATIONS_BROADCAST },
        ],
      },
    ],
  },
]

/**
 * Drops items / children the user lacks permission for. When an item with
 * children survives but every child that survives points back at the parent's
 * `to` (i.e. only "Overview" is left), the children are stripped so the entry
 * renders as a flat link instead of an expandable group.
 */
function filterNavByPermissions(
  sections: NavSection[],
  permissions: ReadonlySet<string>,
): NavSection[] {
  const allowed = (req?: string) => !req || permissions.has(req)
  return sections
    .map((section) => ({
      ...section,
      items: section.items.flatMap<NavItem>((item) => {
        if (!allowed(item.requires)) return []
        if (!item.children) return [item]
        const children = item.children.filter((c) => allowed(c.requires))
        const onlyOverview = children.length === 1 && children[0].to === item.to
        if (children.length === 0 || onlyOverview) {
          return [{ ...item, children: undefined }]
        }
        return [{ ...item, children }]
      }),
    }))
    .filter((s) => s.items.length > 0)
}

/**
 * A top-level nav item owns its whole route subtree: `/matches` stays lit on
 * `/matches/new` and `/matches/123/games/2/scores/edit`, `/players` on
 * `/players/abc`. The trailing slash is load-bearing — a bare `startsWith`
 * would light Players on a sibling like `/players-archive`.
 *
 * Sub-nav children deliberately do NOT use this: they stay on strict equality,
 * or `/notifications/settings` would light both Inbox (`/notifications`) and
 * Preferences at once.
 */
function isUnder(pathname: string, to: string) {
  return pathname === to || pathname.startsWith(`${to}/`)
}

/**
 * What the *screen reader* hears — deliberately narrower than what the eye sees.
 *
 * A TanStack `<Link>` stamps `aria-current="page"` on every link whose `to` is a
 * *prefix* of the location (`activeOptions.exact` defaults to `false`). Left at
 * that default, `/notifications/settings` announced THREE current pages at once
 * — Notifications, Inbox and Preferences — so a screen-reader user was told they
 * were in the inbox while looking at the preferences page (#930). ARIA has
 * exactly one current page; the leaf is it. A section ancestor announces
 * nothing at all, not even `aria-current="true"`.
 *
 * This is the *semantic* layer only. The visual highlight — a parent staying lit
 * over its whole subtree — is computed by `isUnder()` above and applied as
 * `is-active` / `is-parent-active`; no CSS reads `aria-current` or
 * `data-status`, so tightening this cannot dim anything.
 *
 * `includeSearch: false` because these links carry no search of their own: with
 * the router's default the exact match would compare search params *fully*, and
 * `/matches?page=2` would announce no current page at all — trading three lies
 * for a silence.
 */
const EXACT_LINK_ONLY: { exact: true; includeSearch: false } = {
  exact: true,
  includeSearch: false,
}

/**
 * A top-level nav link. Renders exactly what `<Link>` renders — `<Link>` *is*
 * `useLinkProps()` plus an `<a>` — with one attribute under the shell's control
 * instead of the router's: `aria-current`.
 *
 * We have to reach for the hook because `exact` alone cannot finish the job.
 * A section parent and its index child point at the **same URL** (Notifications
 * and Inbox are both `/notifications`; Administration and Overview are both
 * `/admin`), so on the index route an exact match fires for both and two links
 * announce themselves as the current page. No comparison of URLs can separate
 * them — they *are* the same URL. What separates them is that one is an ancestor
 * and the other the leaf, which only the shell knows. And the router hard-codes
 * `aria-current="page"` onto every link it considers active, spread in after
 * `activeProps`, so a prop cannot take it back off.
 *
 * So: a section parent drops the attribute; a childless item is itself the leaf
 * and keeps whatever the router computed. Everything else here — the href, the
 * preloading, the click handling, `data-status` — is still the router's, and
 * none of it touches the visual state, which is the `is-*` classes below.
 */
function TopLevelNavLink({
  item,
  isActive,
  closeOnMobile,
}: {
  item: NavItem
  isActive: boolean
  closeOnMobile: () => void
}) {
  const { 'aria-current': routerAriaCurrent, ...linkProps } = useLinkProps({
    to: item.to,
    activeOptions: EXACT_LINK_ONLY,
    className: cn(
      'app-shell__nav-link',
      // A parent defers the full treatment to its children and keeps only
      // the icon tint.
      isActive && !item.children && 'is-active',
      isActive && item.children && 'is-parent-active',
    ),
    onClick: closeOnMobile,
  })

  return (
    <a
      {...linkProps}
      // A section ancestor announces nothing — not even `aria-current="true"`.
      // ARIA has exactly one current page, and it is the leaf (#930).
      aria-current={item.children ? undefined : routerAriaCurrent}
    >
      <span className="app-shell__nav-icon">{item.icon}</span>
      {item.label}
    </a>
  )
}

function renderNavItem(item: NavItem, pathname: string, closeOnMobile: () => void) {
  // One notion of "you are in this section", used for all three decisions
  // below. Deriving the parent tint from an exhaustive child match instead
  // would leave a route deeper than any listed child (a future
  // `/admin/users/:id`) expanding the sub-nav with nothing lit at all.
  const isActive = isUnder(pathname, item.to)
  return (
    <li key={item.label}>
      <TopLevelNavLink
        item={item}
        isActive={isActive}
        closeOnMobile={closeOnMobile}
      />
      {item.children && isActive ? (
        <ul className="app-shell__sub-nav-list">
          {item.children.map((child) => (
            <li key={child.label}>
              <Link
                to={child.to}
                // The children are leaves, so they announce themselves — but
                // only on their own route. Without `exact`, Inbox
                // (`/notifications`) also claimed to be the current page on
                // `/notifications/settings`, which sits beneath it (#930).
                activeOptions={EXACT_LINK_ONLY}
                className={cn(
                  'app-shell__sub-nav-link',
                  pathname === child.to && 'is-active',
                )}
                onClick={closeOnMobile}
              >
                <span className="app-shell__nav-icon">{child.icon}</span>
                {child.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export interface AppShellProps {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const permissions = useSession().data?.data.user.permissions
  // TanStack Query's default structuralSharing preserves array identity across
  // background refetches when the data is unchanged, so depending on the
  // permissions array (not the whole session) skips the rebuild on no-op
  // refetches.
  const sections = useMemo(
    () => filterNavByPermissions(NAV_SECTIONS, new Set(permissions ?? [])),
    [permissions],
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSidebarOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 960px)')
    function onChange(e: MediaQueryListEvent) {
      if (!e.matches) setSidebarOpen(false)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = sidebarOpen ? 'hidden' : ''
    return () => {
      document.body.style.overflow = previous
    }
  }, [sidebarOpen])

  const closeOnMobile = useCallback(() => {
    if (window.matchMedia('(max-width: 960px)').matches) {
      setSidebarOpen(false)
    }
  }, [])

  return (
    <div className="app-shell dark fortymm-theme">
      <aside
        // The id the topbar hamburger's `aria-controls` points at. Without it
        // that reference dangled, so AT was told the button controlled a region
        // that did not exist (#887).
        id="app-shell-sidebar"
        className={`app-shell__sidebar${sidebarOpen ? ' is-open' : ''}`}
        aria-label="Main navigation"
      >
        <div className="app-shell__sidebar-header">
          <Wordmark size={24} className="app-shell__wordmark" />
          <button
            type="button"
            className="app-shell__sidebar-close"
            aria-label="Close navigation"
            onClick={() => setSidebarOpen(false)}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        <nav className="app-shell__nav">
          {sections.map((section, idx) => (
            <div className="app-shell__nav-section" key={section.label ?? `s-${idx}`}>
              {section.label ? (
                <div className="app-shell__nav-label">{section.label}</div>
              ) : null}
              <ul className="app-shell__nav-list">
                {section.items.map((item) => renderNavItem(item, pathname, closeOnMobile))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="app-shell__main">
        <header className="app-shell__topbar">
          <button
            type="button"
            className="app-shell__menu-btn"
            aria-label="Open navigation"
            aria-controls="app-shell-sidebar"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>

          <a href="#" className="app-shell__brand">
            <div className="app-shell__wordmark">
              FORTY<span className="accent">MM</span>
            </div>
          </a>

          <div className="app-shell__spacer" />

          <div className="app-shell__actions">
            <Popover>
              <PopoverTrigger asChild>
                <Badge
                  asChild
                  variant="outline"
                  className="cursor-pointer gap-1.5 border-amber-500/50 bg-amber-500/15 px-2.5 font-semibold tracking-wider text-amber-300 uppercase shadow-sm transition-colors hover:bg-amber-500/25 hover:text-amber-200 focus-visible:border-amber-400 focus-visible:ring-amber-400/50"
                >
                  <button type="button" aria-label="About the alpha release">
                    <TriangleAlert />
                    Alpha
                    <ChevronDown className="opacity-60" />
                  </button>
                </Badge>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-80 gap-0 overflow-hidden p-0"
              >
                <PopoverHeader className="flex-row items-start gap-3 border-b border-border/60 bg-amber-500/10 p-3.5">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-300">
                    <TriangleAlert className="size-4" />
                  </span>
                  <span className="flex flex-col gap-0.5">
                    <PopoverTitle>You're using an early alpha</PopoverTitle>
                    <PopoverDescription className="text-xs leading-relaxed">
                      FortyMM is under active development — expect rough edges.
                    </PopoverDescription>
                  </span>
                </PopoverHeader>
                <ul className="list-disc space-y-1.5 py-3.5 pr-3.5 pl-8 text-xs leading-relaxed text-muted-foreground">
                  <li>Features may change or break without warning.</li>
                  <li>Your data can be reset or lost at any time.</li>
                  <li>Please don't rely on it for anything important yet.</li>
                </ul>
                <p className="border-t border-border/60 p-3.5 text-xs text-foreground">
                  Thanks for helping us test it. 🏓
                </p>
              </PopoverContent>
            </Popover>
            <NotificationBell />
            <UserMenu />
          </div>
        </header>

        <main className="app-shell__content">{children}</main>
      </div>

      <div
        className={`app-shell__backdrop${sidebarOpen ? ' is-open' : ''}`}
        aria-hidden="true"
        onClick={() => setSidebarOpen(false)}
      />
    </div>
  )
}

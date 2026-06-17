import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import {
  Bell,
  ChevronDown,
  Gauge,
  Key,
  Megaphone,
  Shield,
  TriangleAlert,
  Users,
} from 'lucide-react'
import { useSession } from '@/api/session'
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
    label: 'Play',
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
        label: 'Notifications',
        to: '/notifications',
        icon: <Bell size={18} strokeWidth={2} />,
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

function renderNavItem(item: NavItem, pathname: string, closeOnMobile: () => void) {
  const childActive = item.children?.some((c) => pathname === c.to) ?? false
  const isActive = pathname === item.to || childActive
  return (
    <li key={item.label}>
      <Link
        to={item.to}
        className={cn(
          'app-shell__nav-link',
          isActive && !item.children && 'is-active',
          item.children && childActive && 'is-parent-active',
        )}
        onClick={closeOnMobile}
      >
        <span className="app-shell__nav-icon">{item.icon}</span>
        {item.label}
      </Link>
      {item.children && isActive ? (
        <ul className="app-shell__sub-nav-list">
          {item.children.map((child) => (
            <li key={child.label}>
              <Link
                to={child.to}
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

interface AppShellProps {
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
        className={`app-shell__sidebar${sidebarOpen ? ' is-open' : ''}`}
        aria-label="Main navigation"
      >
        <div className="app-shell__sidebar-header">
          <div className="app-shell__wordmark">
            FORTY<span className="accent">MM</span>
          </div>
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

import { useEffect, useState, type ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { Bell, Gauge, Globe, Key, Mail, MapPin, Shield, User, Users } from 'lucide-react'
import { UserMenu } from './user-menu'

type NavItem = {
  label: string
  icon: ReactNode
  to: string
  children?: Array<{ label: string; to: string; hash?: string; icon: ReactNode }>
}

type NavSection = {
  label: string
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
    ],
  },
  {
    label: 'Workspace',
    items: [
      {
        label: 'Settings',
        to: '/settings',
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
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        ),
        children: [
          { label: 'Username', to: '/settings', hash: 'sec-username', icon: <User size={15} strokeWidth={1.75} /> },
          { label: 'Email', to: '/settings', hash: 'sec-email', icon: <Mail size={15} strokeWidth={1.75} /> },
          { label: 'Home club', to: '/settings', hash: 'sec-club', icon: <MapPin size={15} strokeWidth={1.75} /> },
          { label: 'Notifications', to: '/settings', hash: 'sec-notifications', icon: <Bell size={15} strokeWidth={1.75} /> },
          { label: 'Session', to: '/settings', hash: 'sec-session', icon: <Globe size={15} strokeWidth={1.75} /> },
        ],
      },
      {
        label: 'Administration',
        to: '/admin',
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
          { label: 'Roles', to: '/admin/roles', icon: <Shield size={15} strokeWidth={1.75} /> },
          { label: 'Permissions', to: '/admin/permissions', icon: <Key size={15} strokeWidth={1.75} /> },
          { label: 'Users', to: '/admin/users', icon: <Users size={15} strokeWidth={1.75} /> },
        ],
      },
    ],
  },
]

interface AppShellProps {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const activeHash = useRouterState({
    select: (s) => s.location.hash.replace(/^#/, ''),
  })

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

  function closeOnMobile() {
    if (window.matchMedia('(max-width: 960px)').matches) {
      setSidebarOpen(false)
    }
  }

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
          {NAV_SECTIONS.map((section) => (
            <div className="app-shell__nav-section" key={section.label}>
              <div className="app-shell__nav-label">{section.label}</div>
              <ul className="app-shell__nav-list">
                {section.items.map((item) => {
                  const childActive = item.children?.some((c) => pathname === c.to) ?? false
                  const isActive = pathname === item.to || childActive
                  const linkClassName = `app-shell__nav-link${isActive && !item.children ? ' is-active' : ''}${item.children && childActive ? ' is-parent-active' : ''}`
                  return (
                    <li key={item.label}>
                      <Link
                        to={item.to}
                        className={linkClassName}
                        onClick={closeOnMobile}
                      >
                        <span className="app-shell__nav-icon">{item.icon}</span>
                        {item.label}
                      </Link>
                      {item.children && isActive ? (
                        <ul className="app-shell__sub-nav-list">
                          {item.children.map((child) => {
                            const childIsActive =
                              pathname === child.to &&
                              (!child.hash || activeHash === child.hash)
                            return (
                              <li key={child.label}>
                                <Link
                                  to={child.to}
                                  hash={child.hash}
                                  className={`app-shell__sub-nav-link${childIsActive ? ' is-active' : ''}`}
                                  onClick={closeOnMobile}
                                >
                                  <span className="app-shell__nav-icon">{child.icon}</span>
                                  {child.label}
                                </Link>
                              </li>
                            )
                          })}
                        </ul>
                      ) : null}
                    </li>
                  )
                })}
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

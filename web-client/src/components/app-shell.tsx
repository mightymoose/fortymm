import { useEffect, useState, type ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'

type NavItem = {
  label: string
  icon: ReactNode
  badge?: { label: string; live?: boolean }
  active?: boolean
  to?: string
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
        active: true,
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
        label: 'Live Matches',
        badge: { label: '12', live: true },
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
        label: 'Brackets',
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
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        ),
      },
      {
        label: 'Schedule',
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
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
        ),
      },
      {
        label: 'Tournaments',
        badge: { label: '3' },
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
            <path d="M6 2h12l-2 7H8z" />
            <path d="M9 9v6a3 3 0 0 0 6 0V9" />
            <path d="M5 22h14M10 18h4v4h-4z" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Manage',
    items: [
      {
        label: 'Players',
        badge: { label: '128' },
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
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        ),
      },
      {
        label: 'Courts',
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
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M9 21V9" />
          </svg>
        ),
      },
      {
        label: 'Stats & Rankings',
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
            <path d="M3 3v18h18" />
            <path d="M7 14l4-4 4 4 5-5" />
          </svg>
        ),
      },
      {
        label: 'Achievements',
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
            <circle cx="12" cy="8" r="6" />
            <path d="M15.5 13.5L17 22l-5-3-5 3 1.5-8.5" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Workspace',
    items: [
      {
        label: 'Messages',
        badge: { label: '5' },
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
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        ),
      },
      {
        label: 'Settings',
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
  const [activeLabel, setActiveLabel] = useState(
    () =>
      NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.active)?.label ??
      'Dashboard',
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

  function handleNavClick(e: React.MouseEvent<HTMLAnchorElement>, label: string) {
    e.preventDefault()
    setActiveLabel(label)
    if (window.matchMedia('(max-width: 960px)').matches) {
      setSidebarOpen(false)
    }
  }

  function handleRouteNavClick(label: string) {
    setActiveLabel(label)
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
                  const isActive = item.to
                    ? pathname === item.to
                    : activeLabel === item.label
                  const linkClassName = `app-shell__nav-link${isActive ? ' is-active' : ''}`
                  const inner = (
                    <>
                      <span className="app-shell__nav-icon">{item.icon}</span>
                      {item.label}
                      {item.badge ? (
                        <span
                          className={`app-shell__nav-badge${
                            item.badge.live ? ' app-shell__nav-badge--live' : ''
                          }`}
                        >
                          {item.badge.label}
                        </span>
                      ) : null}
                    </>
                  )
                  return (
                    <li key={item.label}>
                      {item.to ? (
                        <Link
                          to={item.to}
                          className={linkClassName}
                          onClick={() => handleRouteNavClick(item.label)}
                        >
                          {inner}
                        </Link>
                      ) : (
                        <a
                          href="#"
                          className={linkClassName}
                          onClick={(e) => handleNavClick(e, item.label)}
                        >
                          {inner}
                        </a>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="app-shell__sidebar-footer">
          <div className="app-shell__promo">
            <div className="app-shell__promo-title">SPRING OPEN '26</div>
            <div className="app-shell__promo-copy">
              Registration closes in 6 days. 64 spots, double elim.
            </div>
            <a href="#" className="app-shell__promo-btn">
              Register
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14M13 5l7 7-7 7" />
              </svg>
            </a>
          </div>
        </div>
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
            <button
              type="button"
              className="app-shell__user-menu"
              aria-label="User menu"
            >
              <div className="app-shell__user-avatar">RK</div>
              <div className="app-shell__user-name">Rita Kovač</div>
              <span className="app-shell__user-chev">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </span>
            </button>
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

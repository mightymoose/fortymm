import { Fragment, type ReactNode } from 'react'

export interface Crumb {
  label: string
  onClick?: () => void
}

export interface PageHeadingProps {
  breadcrumb: Crumb[]
  /** The big display title. A trailing accent dot is added automatically. */
  title: string
  subtitle?: ReactNode
  action?: ReactNode
}

/** The FortyMM page header: a mono breadcrumb chain with a leading accent dot,
 * a large Bebas display title (with a trailing orange period), an optional
 * subtitle, and a right-aligned action slot. */
export const PageHeading = ({
  breadcrumb,
  title,
  subtitle,
  action,
}: PageHeadingProps) => {
  return (
    <div className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        {breadcrumb.length > 0 && (
          <nav
            aria-label="Breadcrumb"
            className="mb-5 flex items-center gap-3 font-mono text-[11px] font-bold tracking-[0.22em] uppercase"
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-[color:var(--ball-500)]"
            />
            {breadcrumb.map((c, i) => {
              const last = i === breadcrumb.length - 1
              return (
                <Fragment key={`${c.label}-${i}`}>
                  {i > 0 && <span className="text-[color:var(--fg-3)]">/</span>}
                  {c.onClick && !last ? (
                    <button
                      type="button"
                      onClick={c.onClick}
                      className="text-[color:var(--fg-3)] uppercase hover:text-[color:var(--fg-1)]"
                    >
                      {c.label}
                    </button>
                  ) : (
                    <span
                      className={
                        last
                          ? 'max-w-[360px] truncate text-[color:var(--fg-1)]'
                          : 'text-[color:var(--fg-3)]'
                      }
                    >
                      {c.label}
                    </span>
                  )}
                </Fragment>
              )
            })}
          </nav>
        )}
        <h1 className="font-display text-[64px] leading-[0.92] tracking-[0.005em] break-words text-[color:var(--fg-1)] uppercase">
          {title}
          <span className="text-[color:var(--ball-500)]">.</span>
        </h1>
        {subtitle && (
          <p className="mt-5 max-w-[760px] text-[16px] text-[color:var(--fg-3)]">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="shrink-0 sm:pt-7">{action}</div>}
    </div>
  )
}

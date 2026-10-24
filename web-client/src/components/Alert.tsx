import { useId, type ReactNode } from 'react'

export type AlertVariant = 'default' | 'warn' | 'destructive' | 'success'

function AlertIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="alert-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

// Each variant's class and icon: an info circle, a warning triangle, a
// crossed circle and a checked circle.
const variants: Record<AlertVariant, { className: string; icon: ReactNode }> =
  {
    default: {
      className: 'alert--default',
      icon: (
        <AlertIcon>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h0" />
        </AlertIcon>
      ),
    },
    warn: {
      className: 'alert--warn',
      icon: (
        <AlertIcon>
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <path d="M12 9v4M12 17h0" />
        </AlertIcon>
      ),
    },
    destructive: {
      className: 'alert--destructive',
      icon: (
        <AlertIcon>
          <circle cx="12" cy="12" r="10" />
          <path d="M15 9l-6 6M9 9l6 6" />
        </AlertIcon>
      ),
    },
    success: {
      className: 'alert--success',
      icon: (
        <AlertIcon>
          <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
          <path d="M22 4L12 14.01l-3-3" />
        </AlertIcon>
      ),
    },
  }

// A message in the page's flow, e.g. a warning about a tournament, in one
// of the design system's variants: the variant's icon beside a title over a
// description (`children`). Styled by `.alert` in styles/base.css. It's an
// alert, as in shadcn/ui, named by its title.
//
// `headingLevel` has no default: the title's level depends on where the
// alert sits in the page's outline, so each caller picks it.
export function Alert({
  variant = 'default',
  title,
  headingLevel,
  children,
}: {
  variant?: AlertVariant
  title: ReactNode
  headingLevel: 2 | 3 | 4 | 5 | 6
  children: ReactNode
}) {
  const titleId = useId()
  const Heading = `h${headingLevel}` as const
  const { className, icon } = variants[variant]
  return (
    <div role="alert" aria-labelledby={titleId} className={`alert ${className}`}>
      {icon}
      <div>
        <Heading id={titleId} className="alert-title">
          {title}
        </Heading>
        <p className="alert-description">{children}</p>
      </div>
    </div>
  )
}

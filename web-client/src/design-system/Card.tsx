import { type ReactNode, useId } from 'react'

// A card: persistent, structured content, named by its title. `status` sits at the end of the
// head (e.g. a start time); `footer` holds the card's actions, one of them primary at most.
export function Card({
  title,
  subtitle,
  status,
  footer,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  status?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  const titleId = useId()
  return (
    <section className="fm-card" aria-labelledby={titleId}>
      <div className="fm-card__head">
        <div>
          <h3 className="fm-card__title" id={titleId}>
            {title}
          </h3>
          {subtitle && <p className="fm-card__sub">{subtitle}</p>}
        </div>
        {status}
      </div>
      <div className="fm-card__body">{children}</div>
      {footer && <div className="fm-card__foot">{footer}</div>}
    </section>
  )
}

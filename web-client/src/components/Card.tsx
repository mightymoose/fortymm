import { useId, type CSSProperties, type ReactNode } from 'react'

// A card for persistent information, styled by `.fm-card` in styles/kit.css.
// Its head has the title, the optional subtitle, and `status` at the right:
// a status, or a control that acts on the whole card. The children are its
// body, such as a DetailList. `actions` go at the bottom left, the primary
// first, and a card without them has no footer. `style` and `bodyStyle`
// style the card and its body.
export function Card({
  title,
  subtitle,
  status,
  actions,
  style,
  bodyStyle,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  style?: CSSProperties
  bodyStyle?: CSSProperties
  children: ReactNode
}) {
  const titleId = useId()
  return (
    <section className="fm-card" style={style} aria-labelledby={titleId}>
      <div className="fm-card__head">
        <div>
          <h3 className="fm-card__title" id={titleId}>
            {title}
          </h3>
          {subtitle && <p className="fm-card__sub">{subtitle}</p>}
        </div>
        {status}
      </div>
      <div className="fm-card__body" style={bodyStyle}>
        {children}
      </div>
      {actions && <div className="fm-card__foot">{actions}</div>}
    </section>
  )
}

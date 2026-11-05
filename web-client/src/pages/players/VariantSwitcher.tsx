import { Link } from '@tanstack/react-router'
import { Icon } from '../../components/Icon'
import { variants, type Variant } from './variant'

// The prototype's switcher between design options, as links so each option
// has its own URL to share.
export function VariantSwitcher({
  current,
  names,
  playerId,
}: {
  current: Variant
  names: Record<Variant, string>
  playerId?: string
}) {
  return (
    <div className="players-proto">
      <nav className="fm-nav" aria-label="Design option">
        {variants.map((variant) => (
          <Link
            key={variant}
            to={playerId ? '/players/$playerId' : '/players'}
            params={playerId ? { playerId } : undefined}
            search={{ variant }}
            aria-current={variant === current ? 'page' : undefined}
          >
            {variant.toUpperCase()} · {names[variant]}
          </Link>
        ))}
      </nav>
      <p className="fm-notice">
        <Icon name="info" />
        <span>Prototype. Demo players, and nothing here comes from the server.</span>
      </p>
    </div>
  )
}

import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useSignInHref } from '../useSignInHref'
import { matchCountText, type Attention } from './dashboard'
import { NewMatchLink } from './parts'

export type AttentionCopy = { title: string; body: string; action: ReactNode }

// What each attention item says and the one action that resolves it.
export function useAttentionCopy(): (item: Attention, size?: 'sm' | 'lg') => AttentionCopy {
  const signInHref = useSignInHref()
  return (item, size) => {
    const sized = size ? ` fm-btn--${size}` : ''
    switch (item.kind) {
      case 'review-players':
        return {
          title: item.count === 1 ? 'Is this player you?' : `Are these ${item.count} players you?`,
          body: 'A sign-in brought players to your account. Tell us which one is you, so your matches stay together.',
          action: (
            <Link to="/review-players" className={`fm-btn fm-btn--primary${sized}`}>
              Review players
            </Link>
          ),
        }
      case 'keep-guest-matches':
        return {
          title: 'Keep your matches',
          body: `Your ${matchCountText(item.matchCount)} are saved to a guest account on this device. Sign in to keep them with your account on every device.`,
          action: (
            <a href={signInHref} className={`fm-btn fm-btn--primary${sized}`}>
              Sign in
            </a>
          ),
        }
      case 'first-match':
        return {
          title: 'Log your first match',
          body: 'Pick who you played and the format, then keep score at the table. It works with no signal.',
          action: <NewMatchLink size={size} />,
        }
    }
  }
}

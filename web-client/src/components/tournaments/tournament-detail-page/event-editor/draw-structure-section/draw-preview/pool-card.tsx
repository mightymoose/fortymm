import { cn } from '@/lib/utils'

export interface PoolCardProps {
  /** The pool's letter — `A`, `B`, … — from `poolLetter`. The card never derives it,
   * because the letter is the pool's *position* and only the list knows that. */
  letter: string
  /** How many players the derivation lands in this pool. */
  size: number
  /** How many of them reach the knockout. The same number for every pool, and the card
   * needs it to know whether it can supply them. */
  qualifiers: number
}

/**
 * One pool in the live preview: how big it is, and how many of it advance.
 *
 * **The card owns one branch — whether this pool can be played.** A pool of one has
 * nobody to play, and a pool of three cannot send four players to the knockout, so the
 * card reads as bad when its size is under two or under the qualifier count. The
 * derivation reports the same two conditions as *impossible problems*
 * (`data/draw-structure.ts`), but it reports only the FIRST one it hits, for the whole
 * draw. A director looking at eight cards needs to see which pools are the problem, so
 * the card asks the question again of itself.
 *
 * **The bad state is a word, not a colour.** `Too small` is visible text, and the tint
 * is on top of it. A red border alone says nothing to a screen reader and little to a
 * reader who cannot separate the two shades.
 */
export const PoolCard = ({ letter, size, qualifiers }: PoolCardProps) => {
  const tooSmall = size < 2 || size < qualifiers
  return (
    <li
      data-testid="draw-preview-pool-card"
      className={cn(
        'rounded-lg border px-2.5 py-2',
        tooSmall
          ? 'border-[color:var(--loss)]/50 bg-[color:var(--loss)]/10'
          : 'border-[color:var(--border-subtle)] bg-[color:var(--bg-raised)]',
      )}
    >
      <div className="text-[10px] font-semibold tracking-[0.14em] text-[color:var(--fg-3)] uppercase">
        Pool {letter}
      </div>
      <p className="mt-1 font-mono text-[20px] leading-none font-semibold text-[color:var(--fg-1)]">
        {size}
      </p>
      <p className="mt-0.5 text-[11px] text-[color:var(--fg-3)]">players</p>
      {/* Green is the advancing state, and it is only honest on a pool that can supply
          the qualifiers it promises. */}
      <p
        className={cn(
          'mt-1.5 text-[11px]',
          tooSmall
            ? 'text-[color:var(--fg-3)]'
            : 'text-[color:var(--serve-500)]',
        )}
      >
        top {qualifiers} advance
      </p>
      {tooSmall && (
        <p className="mt-1 text-[11px] font-semibold text-[color:var(--loss)]">
          Too small
        </p>
      )}
    </li>
  )
}

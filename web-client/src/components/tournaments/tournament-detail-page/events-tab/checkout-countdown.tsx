import { Clock3 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

/** The hold's server deadline, counted down on the client. It is not a live
 * region: a screen reader reads it on demand and never hears every tick. */
export function CheckoutCountdown({
  expiresAt,
  onExpired,
}: {
  expiresAt: string
  onExpired: () => void
}) {
  const deadline = Date.parse(expiresAt)
  const [now, setNow] = useState(() => Date.now())
  const notified = useRef(false)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1_000))
  useEffect(() => {
    notified.current = false
  }, [expiresAt])
  useEffect(() => {
    if (seconds === 0 && !notified.current) {
      notified.current = true
      onExpired()
    }
  }, [onExpired, seconds])
  const value = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  return (
    <div className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-center">
      <div className="mb-1 flex items-center justify-center gap-1.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        <Clock3 size={13} aria-hidden /> Places held
      </div>
      <div className="font-mono text-3xl font-semibold tabular-nums" aria-label={`${value} remaining`}>
        {value}
      </div>
    </div>
  )
}

import { useState } from 'react'
import { MapPin, MapPinOff } from 'lucide-react'
import { z } from 'zod'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

import type { TournamentsNearMe } from './data/api'

/** The radii (in miles) the picker offers — the API accepts an arbitrary
 * `radius_miles`, but the UI settles the user on a coarse choice. */
const RADIUS_OPTIONS = [25, 50, 100] as const

/** The Geolocation result is UNTRUSTED input like any other boundary
 * (`.claude/rules/parse-at-boundaries.md`): the browser hands back a
 * `GeolocationPosition`, but we only ever carry a `(lat, lng)` inward, and only
 * once it has parsed to two finite numbers. A `NaN`/`Infinity` coordinate — or a
 * shape that is not a position at all — is treated as a failure, not sent to the
 * server as a nonsense query. */
const positionSchema = z.object({
  coords: z.object({
    latitude: z.number().finite(),
    longitude: z.number().finite(),
  }),
})

type Status = 'idle' | 'locating' | 'error'

export interface NearMeControlProps {
  /** Called with the effective near-me filter whenever it changes: the resolved
   * `{ lat, lng, radiusMiles }` triple once the toggle is on AND a location has
   * been granted, or `undefined` whenever it is off, denied, or unavailable. The
   * caller (the tournaments route) feeds this straight to the list query, which
   * re-runs — this control never fetches, it only produces the filter. */
  onNearMeChange: (nearMe: TournamentsNearMe | undefined) => void
}

/** The list's "Near me" filter: a toggle that asks the browser for the user's
 * location, plus a radius picker (25 / 50 / 100 mi).
 *
 * **Graceful failure is load-bearing.** If the user denies permission, the
 * browser errors, or `navigator.geolocation` is unavailable, we do NOT filter —
 * the toggle snaps back off, the parent is handed `undefined` (so the full list
 * stays), and an inline `Alert` explains that location is unavailable. No crash,
 * no permanent spinner. */
export const NearMeControl = ({ onNearMeChange }: NearMeControlProps) => {
  const [enabled, setEnabled] = useState(false)
  const [radiusMiles, setRadiusMiles] = useState<number>(RADIUS_OPTIONS[0])
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [status, setStatus] = useState<Status>('idle')

  /** The one graceful-failure path: fall back to the unfiltered list, snap the
   * toggle off, and surface the inline note. Never leaves a spinner up. */
  const fail = () => {
    setEnabled(false)
    setCoords(null)
    setStatus('error')
    onNearMeChange(undefined)
  }

  const locate = (radius: number) => {
    const geo =
      typeof navigator !== 'undefined' ? navigator.geolocation : undefined
    // Unavailable API (an insecure origin, an old browser) fails exactly like a
    // denial does — the same fallback, no special-casing.
    if (!geo || typeof geo.getCurrentPosition !== 'function') {
      fail()
      return
    }
    setStatus('locating')
    geo.getCurrentPosition(
      (position) => {
        const parsed = positionSchema.safeParse(position)
        if (!parsed.success) {
          fail()
          return
        }
        const { latitude, longitude } = parsed.data.coords
        setCoords({ lat: latitude, lng: longitude })
        setStatus('idle')
        onNearMeChange({ lat: latitude, lng: longitude, radiusMiles: radius })
      },
      // Permission denied, position unavailable, or a timeout — all one fallback.
      () => fail(),
    )
  }

  const handleToggle = (next: boolean) => {
    if (!next) {
      setEnabled(false)
      setCoords(null)
      setStatus('idle')
      onNearMeChange(undefined)
      return
    }
    setEnabled(true)
    // Clear any prior error note on a fresh attempt.
    setStatus('idle')
    locate(radiusMiles)
  }

  const handleRadiusChange = (value: string) => {
    const next = Number(value)
    setRadiusMiles(next)
    // Re-query only if we are actually filtering: the radius is part of the
    // triple, so a change while located re-runs the list. Changing it while off
    // just pre-sets the choice for the next enable.
    if (enabled && coords) {
      onNearMeChange({ ...coords, radiusMiles: next })
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <label className="flex items-center gap-2 text-sm text-[color:var(--fg-2)]">
          <Switch
            checked={enabled}
            onCheckedChange={handleToggle}
            aria-label="Filter by tournaments near me"
          />
          <span className="inline-flex items-center gap-1.5">
            <MapPin size={14} className="text-[color:var(--fg-3)]" />
            Near me
          </span>
        </label>
        <Select value={String(radiusMiles)} onValueChange={handleRadiusChange}>
          <SelectTrigger size="sm" aria-label="Search radius">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RADIUS_OPTIONS.map((r) => (
              <SelectItem key={r} value={String(r)}>
                {r} mi
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {status === 'locating' && (
          <span
            role="status"
            className="font-mono text-[11px] text-[color:var(--fg-3)]"
          >
            Locating…
          </span>
        )}
      </div>

      {status === 'error' && (
        <Alert className="max-w-sm">
          <MapPinOff />
          <AlertTitle>Location unavailable</AlertTitle>
          <AlertDescription>
            We couldn&rsquo;t get your location, so we&rsquo;re showing every
            tournament. Check your browser&rsquo;s location permission and try
            again.
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

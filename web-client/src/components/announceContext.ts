import { createContext, useContext } from 'react'

// Reads `message` out to screen reader users, politely, as kit.js's
// FM.announce does. Nothing shows on screen.
export type Announce = (message: string) => void

export const AnnounceContext = createContext<Announce | null>(null)

// The ToastProvider's function for announcing a change, such as a search's
// result count.
export function useAnnounce(): Announce {
  const announce = useContext(AnnounceContext)
  if (!announce) throw new Error('useAnnounce() needs a ToastProvider above it')
  return announce
}

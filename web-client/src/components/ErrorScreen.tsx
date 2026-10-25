import type { ReactNode } from 'react'

// A full page in place of the app when something fails: the wordmark, then
// the problem, why, and the fixes. It uses the loading screen's frame, and
// is styled by `.error-screen` in styles/base.css.
export function ErrorScreen({
  title,
  children,
  note,
  actions,
}: {
  title: string
  children: ReactNode
  note?: ReactNode
  actions: ReactNode
}) {
  return (
    <main className="error-screen">
      <div className="loading-screen-wordmark">FortyMM</div>
      <h1>{title}</h1>
      <p>{children}</p>
      {note}
      <div className="error-screen-actions">{actions}</div>
    </main>
  )
}

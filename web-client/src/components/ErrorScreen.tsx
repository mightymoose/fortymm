import type { ReactNode } from 'react'

// A full page in place of the app when something fails, or after sign-out:
// the wordmark, then what happened, why, and what to do next. It uses the loading screen's frame, and
// is styled by `.error-screen` in styles/base.css.
export function ErrorScreen({
  title,
  children,
  note,
  actions,
  alert,
}: {
  title: string
  children: ReactNode
  note?: ReactNode
  actions: ReactNode
  // A message above the wordmark, such as why a sign-in didn't finish.
  alert?: ReactNode
}) {
  return (
    <main className="error-screen">
      {alert}
      <div className="loading-screen-wordmark">FortyMM</div>
      <h1>{title}</h1>
      <p>{children}</p>
      {note}
      <div className="error-screen-actions">{actions}</div>
    </main>
  )
}

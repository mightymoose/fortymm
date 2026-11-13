import { createFileRoute } from '@tanstack/react-router'

// The start page, at /: blank, on the theme's background. Its heading is for
// screen readers only.
export const Route = createFileRoute('/')({
  component: StartPage,
})

function StartPage() {
  return (
    <main>
      <h1 className="visually-hidden">FortyMM</h1>
    </main>
  )
}

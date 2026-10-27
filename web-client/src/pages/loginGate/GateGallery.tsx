import { Link } from '@tanstack/react-router'
import { useId, type ComponentType } from 'react'
import { DashboardToast } from './GateParts'
import { frames, type Frame, type QuestionFrame } from './gateData'
import './loginGate.css'

export type LoginGatePath = '/login-gate1' | '/login-gate2' | '/login-gate3'

const layouts: readonly { path: LoginGatePath; name: string }[] = [
  { path: '/login-gate1', name: 'Profile picker' },
  { path: '/login-gate2', name: 'Activity first' },
  { path: '/login-gate3', name: 'Side by side' },
]

const sizes = [
  { key: 'phone', label: 'Phone, 375px' },
  { key: 'desktop', label: 'Desktop, 1280px' },
] as const

// One login gate layout's frames, each at phone and desktop width. Each
// frame is a container, so the layout responds to the frame's width, not the
// window's.
export function GateGallery({
  current,
  description,
  Screen,
}: {
  current: LoginGatePath
  description: string
  Screen: ComponentType<{ question: QuestionFrame }>
}) {
  const name = layouts.find((layout) => layout.path === current)?.name
  return (
    <main className="gate-gallery">
      <header className="gate-gallery__head">
        <nav className="gate-options" aria-label="Layouts">
          {layouts.map((layout) => (
            <Link
              key={layout.path}
              to={layout.path}
              aria-current={layout.path === current ? 'page' : undefined}
            >
              {layout.name}
            </Link>
          ))}
        </nav>
        <h1>Login gate: {name}</h1>
        <p>{description}</p>
        <p className="meta">Visual only. Example players and matches. Nothing is saved.</p>
      </header>
      {frames.map((frame) => (
        <FrameSection key={frame.title} frame={frame} Screen={Screen} />
      ))}
    </main>
  )
}

function FrameSection({
  frame,
  Screen,
}: {
  frame: Frame
  Screen: ComponentType<{ question: QuestionFrame }>
}) {
  const titleId = useId()
  return (
    <section className="gate-gallery__frame" aria-labelledby={titleId}>
      <h2 id={titleId}>{frame.title}</h2>
      <div className="gate-gallery__sizes">
        {sizes.map((size) => (
          <figure key={size.key} className="gate-gallery__size" aria-labelledby={`${titleId}-${size.key}`}>
            <figcaption id={`${titleId}-${size.key}`} className="meta">
              {size.label}
            </figcaption>
            <div className="gate-gallery__scroll">
              <div className={`gate-frame gate-frame--${size.key}`}>
                {frame.kind === 'question' ? (
                  <Screen question={frame.question} />
                ) : (
                  <DashboardToast answer={frame.answer} />
                )}
              </div>
            </div>
          </figure>
        ))}
      </div>
    </section>
  )
}

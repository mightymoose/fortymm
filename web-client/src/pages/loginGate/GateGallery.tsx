import { Link } from '@tanstack/react-router'
import { useId, type ReactNode } from 'react'
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

// One frame of a layout: its title and what it draws.
export type GalleryFrame = { title: string; render: () => ReactNode }

// One login gate layout's frames, each at phone and desktop width. Each
// frame is a container, so the layout responds to the frame's width, not the
// window's. `children` goes under the page's header.
export function GateGallery({
  current,
  description,
  frames,
  children,
}: {
  current: LoginGatePath
  description: string
  frames: readonly GalleryFrame[]
  children?: ReactNode
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
      {children}
      {frames.map((frame) => (
        <FrameSection key={frame.title} frame={frame} />
      ))}
    </main>
  )
}

function FrameSection({ frame }: { frame: GalleryFrame }) {
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
              <div className={`gate-frame gate-frame--${size.key}`}>{frame.render()}</div>
            </div>
          </figure>
        ))}
      </div>
    </section>
  )
}

import { type CSSProperties, type ReactNode } from 'react'

// One example on a showcase board: its title and description beside the example itself, or, when
// isWide, above it, with the example taking the board's full width (e.g. a split view).
// stageStyle overrides the example's layout where a board does, e.g. { gap: 0 }.
export function ShowcaseExample({
  testId,
  title,
  description,
  isWide,
  stageStyle,
  children,
}: {
  testId: string
  title: string
  description: ReactNode
  isWide?: boolean
  stageStyle?: CSSProperties
  children: ReactNode
}) {
  return (
    <div
      className="doc-ex"
      data-testid={testId}
      style={isWide ? { gridTemplateColumns: 'minmax(0,1fr)' } : undefined}
    >
      <header style={isWide ? { maxWidth: 640 } : undefined}>
        <h3>{title}</h3>
        <p>{description}</p>
      </header>
      <div className="doc-stage" style={stageStyle}>
        {children}
      </div>
    </div>
  )
}

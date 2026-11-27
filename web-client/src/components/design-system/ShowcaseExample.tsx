import { type CSSProperties, type ReactNode } from 'react'

// One example on a showcase board: its title and description beside the example itself.
// stageStyle overrides the example's layout where a board does, e.g. { gap: 0 }.
export function ShowcaseExample({
  testId,
  title,
  description,
  stageStyle,
  children,
}: {
  testId: string
  title: string
  description: string
  stageStyle?: CSSProperties
  children: ReactNode
}) {
  return (
    <div className="doc-ex" data-testid={testId}>
      <header>
        <h3>{title}</h3>
        <p>{description}</p>
      </header>
      <div className="doc-stage" style={stageStyle}>
        {children}
      </div>
    </div>
  )
}

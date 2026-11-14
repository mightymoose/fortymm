import type { ReactNode } from 'react'
import './Board.css'

// The layout of the design system page's tabs, after the reference sheet's
// own (its ref-* classes in references/design-system/reference.css): each
// tab is one board of the sheet, in sections, and each example sits on a
// stage, the target a screenshot takes, named by the board's data-testid.
// None of it is part of the design system: it only lays the examples out as
// the board does, so a target here can be set beside the same target there.

// One tab's board: its title (the tab's name) and what it shows.
export function Board({
  id,
  title,
  intro,
  children,
}: {
  id: string
  title: string
  intro: ReactNode
  children: ReactNode
}) {
  return (
    <section className="board" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>{title}</h2>
      <p className="board__intro">{intro}</p>
      {children}
    </section>
  )
}

// A section of a board: its heading, a line about it, and its examples.
// `testId` is the board's section-<name>.
export function BoardSection({
  id,
  testId,
  title,
  description,
  children,
}: {
  id: string
  testId: string
  title: string
  description: ReactNode
  children: ReactNode
}) {
  return (
    <section
      className="board__section"
      aria-labelledby={id}
      data-testid={testId}
    >
      <h3 id={id}>{title}</h3>
      <p className="board__description">{description}</p>
      {children}
    </section>
  )
}

// Examples side by side, `columns` to a row, as the board's ref-grid.
export function BoardGrid({
  columns,
  children,
}: {
  columns: 2 | 3 | 4 | 6 | 7 | 8
  children: ReactNode
}) {
  return (
    <div className={`board__grid board__grid--${columns}`}>{children}</div>
  )
}

export type StageLayout = 'row' | 'bottom' | 'center' | 'column' | 'block'

// A stage: what a screenshot of a target takes. Its example sits in a row
// (centred vertically; `bottom` aligns the row to the bottom, `center`
// centres it both ways), a column stretched to the stage's width, or a block
// filling it. On bg-app, or on bg-panel with `panel` (with the board's
// rounded corners).
export function Stage({
  testId,
  layout = 'row',
  panel = false,
  className,
  children,
}: {
  testId: string
  layout?: StageLayout
  panel?: boolean
  // A class of the tab's own CSS, for what the board gives one stage of its
  // own (a wider padding, a gap).
  className?: string
  children: ReactNode
}) {
  const classes = [
    'board__stage',
    layout !== 'row' && `board__stage--${layout}`,
    panel && 'board__stage--panel',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={classes} data-testid={testId}>
      {children}
    </div>
  )
}

// One example: its stage, and a caption outside it naming the example and
// what it is made of.
export function Spec({
  title,
  detail,
  children,
}: {
  title: ReactNode
  detail: ReactNode
  // The example's stage.
  children: ReactNode
}) {
  return (
    <figure className="board__spec">
      {children}
      <figcaption className="board__caption">
        <b>{title}</b>
        <span>{detail}</span>
      </figcaption>
    </figure>
  )
}

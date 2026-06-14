export interface TimeCellView {
  /** The already-formatted relative/absolute time string (e.g. '14:32',
   * 'yesterday', '5d ago', or a locale date). Computed by the row projector's
   * formatCreatedAt. */
  when: string
}

export interface TimeCellProps {
  time: TimeCellView
}

export const TimeCell = ({ time }: TimeCellProps) => {
  return (
    <span className="time-cell">
      <span className="strong">{time.when}</span>
    </span>
  )
}

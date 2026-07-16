import {
  buildTimelineBoardShellProps,
  buildTimelineBoardShellRow,
} from './timeline-board-shell.factory'
import { timelineBoardShellPage as page } from './timeline-board-shell.page'

describe('TimelineBoardShell', () => {
  it('renders a labelled, keyboard-focusable scroll region (#1035 family)', () => {
    page.render(buildTimelineBoardShellProps({ regionLabel: 'Schedule by table' }))
    const region = page.getRegion('Schedule by table')
    expect(region).toHaveAttribute('tabindex', '0')
  })

  it('names the label column and renders every row under its test id', () => {
    page.render(
      buildTimelineBoardShellProps({
        headerLabel: 'Player',
        rows: [
          buildTimelineBoardShellRow({
            key: 'u-1',
            testId: 'shell-row-u-1',
            label: <span>rita.kovac</span>,
          }),
          buildTimelineBoardShellRow({ key: 'u-2', testId: 'shell-row-u-2' }),
        ],
      }),
    )
    expect(page.getRegion('Schedule by table')).toHaveTextContent('Player')
    expect(page.getRow('shell-row-u-1')).toHaveTextContent('rita.kovac')
    expect(page.queryRow('shell-row-u-2')).not.toBeNull()
  })

  it("renders a row's bars inside its track", () => {
    page.render(
      buildTimelineBoardShellProps({
        rows: [
          buildTimelineBoardShellRow({
            bars: <button type="button">a bar</button>,
          }),
        ],
      }),
    )
    expect(page.getRow('shell-row-row-1')).toHaveTextContent('a bar')
  })
})

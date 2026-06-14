import { buildTimeCellView } from './time-cell.factory'
import { timeCellPage } from './time-cell.page'

describe('TimeCell', () => {
  it('renders the formatted time string inside the strong span', () => {
    timeCellPage.render({ time: buildTimeCellView({ when: '5d ago' }) })

    const span = timeCellPage.getWhen('5d ago')
    expect(span).toHaveTextContent('5d ago')
    expect(span).toHaveClass('strong')
  })

  it('renders the time-cell wrapper class', () => {
    timeCellPage.render({ time: buildTimeCellView({ when: 'yesterday' }) })

    expect(timeCellPage.getTime('yesterday')).toHaveClass('time-cell')
  })
})

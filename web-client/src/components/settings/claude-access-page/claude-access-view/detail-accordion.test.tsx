import userEvent from '@testing-library/user-event'

import { buildDetailAccordionItem } from './detail-accordion.factory'
import { detailAccordionPage } from './detail-accordion.page'

describe('DetailAccordion', () => {
  it('starts closed, so the page opens on its status rather than its reference material', () => {
    detailAccordionPage.render({ title: 'Troubleshooting' })

    expect(detailAccordionPage.queryAccordion('Troubleshooting')).not.toBeNull()
    expect(detailAccordionPage.isOpen('Troubleshooting')).toBe(false)
  })

  it('discloses its lines when the summary is activated', async () => {
    detailAccordionPage.render({
      title: 'Troubleshooting',
      items: [
        buildDetailAccordionItem({
          term: 'Revoking',
          detail: 'disconnect on this page',
        }),
      ],
    })

    await userEvent.click(detailAccordionPage.getSummary('Troubleshooting'))

    expect(detailAccordionPage.isOpen('Troubleshooting')).toBe(true)
  })

  it('renders each line as its term followed by the explanation', () => {
    detailAccordionPage.render({
      title: 'Troubleshooting',
      items: [
        buildDetailAccordionItem({
          term: 'Revoking',
          detail: 'disconnect on this page and we stop authorizing requests',
        }),
      ],
    })

    const items = detailAccordionPage.getItems('Troubleshooting')
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent(
      'Revoking — disconnect on this page and we stop authorizing requests',
    )
  })
})

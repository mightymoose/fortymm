import userEvent from '@testing-library/user-event'

import { buildEvent } from '../../data/seed.factory'
import { buildPredicate } from '../../data/seed.factory'
import { eligibilitySectionPage } from './eligibility-section.page'

describe('EligibilitySection', () => {
  it('shows the open-to-all empty state with no rules', () => {
    eligibilitySectionPage.render({ event: buildEvent({ predicates: [] }) })
    expect(eligibilitySectionPage.queryRows()).toHaveLength(0)
    expect(document.body).toHaveTextContent('Open to all players')
  })

  it('appends a rule when Add rule is clicked', async () => {
    const onChange = vi.fn()
    eligibilitySectionPage.render({
      event: buildEvent({ predicates: [buildPredicate()] }),
      onChange,
    })

    await userEvent.click(eligibilitySectionPage.getAddRuleButton())
    expect(onChange.mock.calls.at(-1)?.[0].predicates).toHaveLength(2)
  })
})

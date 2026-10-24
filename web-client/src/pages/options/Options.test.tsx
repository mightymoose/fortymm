import { describe, expect, it } from 'vitest'
import { OptionsPage } from '../../test/pages/OptionsPage'
import { holdHealth } from '../../test/server'
import { optionPath, options } from './catalog'

describe('Options', () => {
  it('lists every option with a link to it, and makes no request', async () => {
    const health = holdHealth()
    const page = await OptionsPage.render()

    expect(page.title).toHaveTextContent('Options')
    for (const option of options) {
      expect(page.link(option.title)).toHaveAttribute('href', optionPath(option.slug))
    }
    expect(health.requests).toHaveLength(0)
  })

  it.each(options)('shows the $title option ($slug)', async (option) => {
    const health = holdHealth()
    const page = await OptionsPage.render(optionPath(option.slug))

    expect(page.optionName).toHaveTextContent(option.title)
    expect(page.title).toBeInTheDocument()
    expect(health.requests).toHaveLength(0)
  })
})

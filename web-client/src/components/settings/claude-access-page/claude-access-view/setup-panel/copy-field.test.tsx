import userEvent from '@testing-library/user-event'

import { copyFieldPage } from './copy-field.page'

describe('CopyField', () => {
  it('shows the value verbatim, so what is pasted is what was read', () => {
    copyFieldPage.render({
      label: 'Connector URL',
      value: 'https://fortymm.com/api/mcp/',
    })

    expect(copyFieldPage.getCopyValue('Connector URL')).toHaveTextContent(
      'https://fortymm.com/api/mcp/',
    )
  })

  it('ties the copy button to the field it copies', () => {
    copyFieldPage.render({
      label: 'Client ID · under Advanced settings',
      buttonLabel: 'Copy client ID',
    })

    expect(copyFieldPage.getCopyButtonDescription('Copy client ID')).toBe(
      'Client ID · under Advanced settings',
    )
  })

  it('marks nothing until something has been copied', () => {
    copyFieldPage.render({ outcome: null })

    expect(copyFieldPage.queryCopiedMarker('Connector URL')).toBeNull()
    expect(copyFieldPage.queryCopyError('Connector URL')).toBeNull()
  })

  it('marks a value that reached the clipboard', () => {
    copyFieldPage.render({ outcome: 'copied' })

    expect(copyFieldPage.queryCopiedMarker('Connector URL')).toBeInTheDocument()
    expect(copyFieldPage.queryCopyError('Connector URL')).toBeNull()
  })

  it('says what to do instead when the clipboard could not be reached', () => {
    copyFieldPage.render({ outcome: 'failed' })

    expect(copyFieldPage.queryCopyError('Connector URL')).toHaveTextContent(
      "We couldn't reach your clipboard. Select the value above and copy it yourself.",
    )
    // A failure that also claimed COPIED would be worse than no marker at all.
    expect(copyFieldPage.queryCopiedMarker('Connector URL')).toBeNull()
  })

  it('asks its owner to copy when pressed', async () => {
    const onCopy = vi.fn()
    copyFieldPage.render({ buttonLabel: 'Copy URL', onCopy })

    await userEvent.click(copyFieldPage.getCopyButton('Copy URL'))

    expect(onCopy).toHaveBeenCalledTimes(1)
  })
})

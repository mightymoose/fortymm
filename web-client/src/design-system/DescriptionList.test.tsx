import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DescriptionList } from './DescriptionList.tsx'

describe('DescriptionList', () => {
  it('describes each term', () => {
    render(<DescriptionList items={[{ term: 'Table', details: 'Table 2' }]} />)
    expect(screen.getByRole('definition')).toHaveTextContent('Table 2')
  })
})

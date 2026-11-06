import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import vectors from '../../../api/signed-results/vectors.json'
import { readQrCode } from '../test/readQrCode'
import { QrCode } from './QrCode'

// The longest result's approval link from the longest Preview origin
// (`bin/preview-name` keeps a name to 30 characters), for a match with a UUID.
const fragment = vectors.valid.find((vector) => vector.name === 'longest')!.link.split('#')[1]
const longest =
  `https://${'a'.repeat(30)}-fortymm.mightymoose.workers.dev` +
  `/matches/0b0e5c6e-3c39-4f6e-9a0e-2a2f1d7f5b9c/scores/approvals/new#${fragment}`

// The QR's width on a 360px screen, from `.qr-code` in scoring.css.
const SHOWN_PX = 320

describe('QrCode', () => {
  it('encodes the text so a camera reads it back', () => {
    render(<QrCode text={longest} label="Result QR code" />)

    expect(readQrCode(screen.getByRole('img', { name: 'Result QR code' }))).toBe(longest)
  })

  it('draws the longest approval link with modules of at least 3px on a phone', () => {
    render(<QrCode text={longest} label="Result QR code" />)

    const extent = Number(screen.getByRole('img', { name: 'Result QR code' }).getAttribute('viewBox')!.split(' ')[2])
    expect(SHOWN_PX / extent).toBeGreaterThanOrEqual(3)
  })
})

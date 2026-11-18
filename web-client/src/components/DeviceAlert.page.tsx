import { screen } from '@testing-library/react'
import type { NewVersionOffer } from './DeviceAlert.tsx'

// For the pages of screens that show what the device refused (DeviceAlert):
// the error alert, found by its role, wherever it is mounted.
export function findAlert() {
  return screen.findByRole('alert')
}

export function queryAlert() {
  return screen.queryByRole('alert')
}

// No new deployment waiting: what a screen is given unless a test says
// otherwise.
export const noNewVersion: NewVersionOffer = { waiting: false, reload: () => {} }

import { ApiError } from '@/api/client'

export function receiptMutationErrorMessage(error: unknown): string | null {
  if (!(error instanceof ApiError) || (error.status !== 409 && error.status !== 422)) {
    return null
  }
  return error.status === 409
    ? 'This receipt destination can no longer be changed.'
    : 'Enter a valid email address or leave this blank.'
}

import type { FieldValues, Path, UseFormReturn } from 'react-hook-form'
import { toast } from 'sonner'
import { ApiError } from '@/api/client'

/** A TanStack mutation `onError` handler that surfaces the failure as a toast.
 * `verb` completes the sentence "Couldn't <verb>" (e.g. "create the
 * tournament"). Shared by the RBAC and tournament data layers. */
export function notifyError(verb: string) {
  return (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    toast.error(`Couldn't ${verb}`, { description: message })
  }
}

/** Route a failed form-submit mutation. A 409/422 is the server refusing a value
 * the client-side schema let through — pin it inline on `field` and keep the
 * dialog open. Anything else falls through to a "Couldn't <verb>" toast. Returns
 * true when it set an inline error, so the caller can react (e.g. reveal the
 * field's section). */
export function applyServerFieldError<T extends FieldValues>(
  form: UseFormReturn<T>,
  field: Path<T>,
  error: unknown,
  verb: string,
  fallbackMessage = 'The server rejected this value.',
): boolean {
  if (error instanceof ApiError && (error.status === 409 || error.status === 422)) {
    form.setError(field, { type: 'server', message: error.detail ?? fallbackMessage })
    return true
  }
  notifyError(verb)(error)
  return false
}

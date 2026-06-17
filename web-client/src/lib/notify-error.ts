import { toast } from 'sonner'

/** A TanStack mutation `onError` handler that surfaces the failure as a toast.
 * `verb` completes the sentence "Couldn't <verb>" (e.g. "create the
 * tournament"). Shared by the RBAC and tournament data layers. */
export function notifyError(verb: string) {
  return (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    toast.error(`Couldn't ${verb}`, { description: message })
  }
}

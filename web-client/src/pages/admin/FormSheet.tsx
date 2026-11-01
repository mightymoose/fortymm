import { useEffect, useId, useRef, type FormEventHandler, type ReactNode } from 'react'
import { Button } from '../../components/Button'
import { closeDialog } from '../../components/closeDialog'
import { Sheet } from '../../components/Sheet'
import { WriteError } from './WriteError'

// A form in a drawer, open from when it mounts. The submit button sits in
// the drawer's footer, outside the form, so it names the form by id. It
// shows "Saving…" and ignores clicks while `submitting`. `failure` is the
// last write's error, shown above the fields. The drawer closes once
// `saved`, and the caller unmounts it in `onClose`.
export function FormSheet({
  title,
  subtitle,
  submitLabel,
  submitting,
  saved,
  failure,
  onSubmit,
  onClose,
  children,
}: {
  title: string
  subtitle: string
  submitLabel: string
  submitting: boolean
  saved: boolean
  failure: unknown
  onSubmit: FormEventHandler<HTMLFormElement>
  onClose: () => void
  children: ReactNode
}) {
  const sheet = useRef<HTMLDialogElement>(null)
  const formId = useId()

  useEffect(() => {
    sheet.current?.showModal()
  }, [])

  useEffect(() => {
    if (saved) sheet.current?.close()
  }, [saved])

  return (
    <Sheet
      ref={sheet}
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            busy={submitting}
            disabled={submitting}
          >
            {submitting ? 'Saving…' : submitLabel}
          </Button>
          <Button variant="ghost" onClick={closeDialog}>
            Cancel
          </Button>
        </>
      }
    >
      <form id={formId} className="admin-form" noValidate onSubmit={onSubmit}>
        {failure != null && <WriteError error={failure} />}
        {children}
      </form>
    </Sheet>
  )
}

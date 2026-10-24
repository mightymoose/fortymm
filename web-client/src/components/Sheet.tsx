import { useId, type ComponentProps, type ReactNode } from 'react'
import { Button } from './Button'
import { Icon } from './Icon'
import { closeDialog } from './closeDialog'
import { ModalDialog } from './ModalDialog'

// A sheet, styled by `.fm-sheet` in styles/kit.css: a drawer from the right
// for a task that needs more room than a dialog, or with `bottom` a sheet
// from the bottom for a short choice. Its head has the title, a subtitle and
// Close, its body scrolls, and `footer` holds the actions, pinned at the
// bottom. Open it with showModal() on its ref.
//
// As a `form`, its content is a `<form method="dialog">`, so a submit
// button closes it with its value as the dialog's returnValue, and Close
// submits "cancel".
export function Sheet({
  title,
  subtitle,
  bottom = false,
  form = false,
  footer,
  children,
  ...props
}: Omit<ComponentProps<'dialog'>, 'title'> & {
  title: string
  subtitle: string
  bottom?: boolean
  form?: boolean
  footer: ReactNode
}) {
  const titleId = useId()
  const content = (
    <>
      <div className="fm-sheet__head">
        <div>
          <h2 id={titleId}>{title}</h2>
          <p>{subtitle}</p>
        </div>
        {form ? (
          <Button variant="ghost" icon type="submit" value="cancel" aria-label="Close">
            <Icon name="x" />
          </Button>
        ) : (
          <Button variant="ghost" icon aria-label="Close" onClick={closeDialog}>
            <Icon name="x" />
          </Button>
        )}
      </div>
      <div className="fm-sheet__body">{children}</div>
      <div className="fm-sheet__foot">{footer}</div>
    </>
  )
  return (
    <ModalDialog
      className={bottom ? 'fm-sheet fm-sheet--bottom' : 'fm-sheet'}
      aria-labelledby={titleId}
      {...props}
    >
      {form ? <form method="dialog">{content}</form> : content}
    </ModalDialog>
  )
}

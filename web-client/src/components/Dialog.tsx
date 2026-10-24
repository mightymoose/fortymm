import { useId, type ComponentProps, type ReactNode } from 'react'
import { ModalDialog } from './ModalDialog'

// A modal dialog that asks before a change, styled by `.fm-dialog` in
// styles/kit.css: the question as its title, the consequence, then the
// `actions`, the safe choice first. Open it with showModal() on its ref.
// Actions close it with closeDialog().
export function Dialog({
  title,
  actions,
  children,
  ...props
}: Omit<ComponentProps<'dialog'>, 'title'> & {
  title: string
  actions: ReactNode
}) {
  const titleId = useId()
  return (
    <ModalDialog className="fm-dialog" aria-labelledby={titleId} {...props}>
      <h2 id={titleId}>{title}</h2>
      {children}
      <div className="fm-dialog__actions">{actions}</div>
    </ModalDialog>
  )
}

import type { ComponentProps } from 'react'
import { createPortal } from 'react-dom'

// A native <dialog> for a modal overlay. Open it with showModal() on its
// ref: the browser then traps focus in it, closes it on Esc and puts focus
// back on the control that opened it. A click on the backdrop closes it
// too, as in kit.js. Buttons close it with closeDialog(). Dialog, Sheet and CommandPalette give it their look.
export function ModalDialog({ onClick, ...props }: ComponentProps<'dialog'>) {
  // On <body>, as the gallery puts its dialogs, so the gallery's `only` test
  // mode keeps them on screen whichever example is shown.
  return createPortal(
    <dialog
      {...props}
      onClick={(event) => {
        onClick?.(event)
        const dialog = event.currentTarget
        // A click on the backdrop lands on the dialog itself, outside its box.
        if (event.target !== dialog) return
        const box = dialog.getBoundingClientRect()
        const outside =
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        if (outside) dialog.close()
      }}
    />,
    document.body,
  )
}

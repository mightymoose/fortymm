import type { MouseEvent } from 'react'

// Closes the <dialog> that holds the clicked button, with the button's value
// as its returnValue, as kit.js's `data-close` buttons do.
export function closeDialog(event: MouseEvent<HTMLButtonElement>): void {
  event.currentTarget.closest('dialog')?.close(event.currentTarget.value)
}

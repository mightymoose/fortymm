import type { ComponentProps } from 'react'
import { Button } from '../../components/Button'
import { useToast } from '../../components/toastContext'

// A button for an action that would need a server, as the gallery's
// `data-demo` buttons are: a click only says so in a toast.
export function DemoButton({
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, 'children' | 'onClick'> & {
  children: string
}) {
  const showToast = useToast()
  return (
    <Button
      {...props}
      onClick={() =>
        showToast(`“${children}” isn’t wired up in this demo`, { icon: 'info' })
      }
    >
      {children}
    </Button>
  )
}

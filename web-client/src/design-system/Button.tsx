import { type ReactNode } from 'react'
import { Button as AriaButton, type PressEvent } from 'react-aria-components'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid'
export type ButtonSize = 'sm' | 'lg' | 'xl'

// A button: React Aria's Button (press, hover and focus handling) drawn with kit.css's fm-btn
// classes. Label it with the verb that happens; one primary per card or dialog.
//
// - isPending: the action is running. Keeps its colours, ignores presses, and is aria-busy (React
//   Aria marks it aria-disabled, which kit.css draws as disabled; the board draws it busy).
// - isDisabled: can't be used. With a disabledReason (the id of the text that says why) it stays
//   focusable, so the reason is read out with it; without one it is a native disabled button.
// - An icon-only button (isIconOnly) needs an aria-label.
// - className adds a component's own class when a button is part of one, e.g. fm-toast__action.
export function Button({
  variant,
  size,
  isIconOnly,
  isBlock,
  className: extraClassName,
  isPending,
  isDisabled,
  disabledReason,
  onPress,
  'aria-label': ariaLabel,
  children,
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  isIconOnly?: boolean
  isBlock?: boolean
  className?: string
  isPending?: boolean
  isDisabled?: boolean
  disabledReason?: string
  onPress?: (e: PressEvent) => void
  'aria-label'?: string
  children: ReactNode
}) {
  const className = [
    'fm-btn',
    variant && `fm-btn--${variant}`,
    size && `fm-btn--${size}`,
    isIconOnly && 'fm-btn--icon',
    isBlock && 'fm-btn--block',
    extraClassName,
  ]
    .filter(Boolean)
    .join(' ')
  const explained = isDisabled && disabledReason !== undefined
  return (
    <AriaButton
      className={className}
      isPending={isPending}
      isDisabled={isDisabled && !explained}
      aria-disabled={explained || undefined}
      aria-describedby={explained ? disabledReason : undefined}
      aria-label={ariaLabel}
      onPress={explained ? undefined : onPress}
      render={(props, { isPending }) => (
        <button
          {...props}
          aria-disabled={isPending ? undefined : props['aria-disabled']}
          aria-busy={isPending || undefined}
        />
      )}
    >
      {children}
    </AriaButton>
  )
}

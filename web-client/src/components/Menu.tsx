import type { ComponentProps, CSSProperties, Ref } from 'react'

// A command in a menu. `shortcut` shows at its right, e.g. "⌘P". `danger`
// colours a destructive command red.
export type MenuCommand = { label: string; shortcut?: string; danger?: boolean }

// A menu's commands in order. A divider goes before the destructive ones.
export type MenuItems = readonly (MenuCommand | 'divider')[]

// A menu of commands, styled by `.fm-menu` in styles/kit.css and named
// `label`. `commandProps` gives each command's button its behaviour, such as
// a click handler. `id`, `hidden`, `style` and `ref` go to the menu itself.
export function Menu({
  label,
  items,
  commandProps,
  id,
  hidden,
  style,
  ref,
}: {
  label: string
  items: MenuItems
  commandProps?: (command: MenuCommand) => ComponentProps<'button'>
  id?: string
  hidden?: boolean
  style?: CSSProperties
  ref?: Ref<HTMLDivElement>
}) {
  return (
    <div
      className="fm-overlay fm-menu"
      role="menu"
      aria-label={label}
      id={id}
      hidden={hidden}
      style={style}
      ref={ref}
    >
      {items.map((item, at) =>
        item === 'divider' ? (
          <hr key={`divider${at}`} />
        ) : (
          <button
            key={item.label}
            type="button"
            className={item.danger ? 'fm-menu__item fm-menu__item--danger' : 'fm-menu__item'}
            role="menuitem"
            {...commandProps?.(item)}
          >
            {item.label}
            {item.shortcut && <small>{item.shortcut}</small>}
          </button>
        ),
      )}
    </div>
  )
}

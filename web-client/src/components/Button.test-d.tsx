// Type-level tests, checked by `tsc -b` (web-client:typecheck). Nothing here
// runs or ships: no module imports this file.
import { Button } from './Button.tsx'
import { Icon } from './Icon.tsx'

export function IconOnlyButtonsWithAName() {
  return (
    <Button variant="secondary" iconOnly aria-label="More actions">
      <Icon name="ellipsis" />
    </Button>
  )
}

// A button that shows only an icon has no text to name it, so it must be
// given a label. If Button stopped requiring one, the expect-error directive
// would be unused, and tsc would fail.
export function IconOnlyButtonWithoutAName() {
  return (
    // @ts-expect-error: an icon-only button needs an aria-label.
    <Button variant="secondary" iconOnly>
      <Icon name="ellipsis" />
    </Button>
  )
}

import type { ReactNode } from 'react'
import { AvatarCircle, type AvatarSize } from './Avatar'
import { AvatarGroupSizeContext } from './avatarGroupContext'

// Avatars stacked so each overlaps the one before, then, given `overflow`,
// a circle counting the people not shown.
export function AvatarGroup({
  label,
  size = 'md',
  overflow,
  children,
}: {
  label: string
  size?: AvatarSize
  overflow?: number
  children: ReactNode
}) {
  return (
    <div className="avatar-group" role="group" aria-label={label}>
      <AvatarGroupSizeContext.Provider value={size}>
        {children}
      </AvatarGroupSizeContext.Provider>
      {overflow !== undefined && (
        <AvatarCircle
          label={`${overflow} more`}
          text={`+${overflow}`}
          size={size}
          tone="neutral"
        />
      )}
    </div>
  )
}

import { createContext, useContext } from 'react'
import type { AvatarSize } from './Avatar'

export const AvatarGroupSizeContext = createContext<AvatarSize | undefined>(
  undefined,
)

export function useAvatarGroupSize(): AvatarSize | undefined {
  return useContext(AvatarGroupSizeContext)
}

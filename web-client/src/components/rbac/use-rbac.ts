import { useContext } from 'react'
import {
  RbacActionsCtx,
  RbacDataCtx,
  type RbacActions,
  type RbacData,
} from './rbac-context-internal'

export function useRbacData(): RbacData {
  const v = useContext(RbacDataCtx)
  if (!v) throw new Error('useRbacData must be used inside <RbacProvider>')
  return v
}

export function useRbacActions(): RbacActions {
  const v = useContext(RbacActionsCtx)
  if (!v) throw new Error('useRbacActions must be used inside <RbacProvider>')
  return v
}

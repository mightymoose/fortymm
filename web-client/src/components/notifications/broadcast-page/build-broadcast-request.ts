import type { BroadcastRequest } from '@/api/notifications'

export type BroadcastAudience = 'all' | 'selected'

export interface BroadcastDraft {
  audience: BroadcastAudience
  selectedIds: ReadonlySet<string>
  title: string
  body: string
}

/** A broadcast is sendable once it has an audience (everyone, or ≥1 picked
 * player) and a non-blank title. The server delivers per each recipient's
 * notification preferences — there's no channel selection. */
export function canSendBroadcast(
  draft: Pick<BroadcastDraft, 'audience' | 'selectedIds' | 'title'>,
): boolean {
  const hasAudience = draft.audience === 'all' || draft.selectedIds.size > 0
  return hasAudience && draft.title.trim().length > 0
}

/** Build the wire request from the draft. */
export function buildBroadcastRequest(draft: BroadcastDraft): BroadcastRequest {
  return {
    recipients:
      draft.audience === 'all'
        ? { mode: 'all' }
        : { mode: 'selected', user_ids: [...draft.selectedIds] },
    title: draft.title.trim(),
    body: draft.body.trim(),
  }
}

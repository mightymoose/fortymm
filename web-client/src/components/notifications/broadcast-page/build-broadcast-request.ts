import type { BroadcastRequest, NotificationChannel } from '@/api/notifications'

export type BroadcastAudience = 'all' | 'selected'

export interface BroadcastDraft {
  audience: BroadcastAudience
  selectedIds: ReadonlySet<string>
  channels: ReadonlySet<NotificationChannel>
  title: string
  body: string
}

/** A broadcast is sendable once it has an audience (everyone, or ≥1 picked
 * player), at least one channel, and a non-blank title. */
export function canSendBroadcast(
  draft: Pick<BroadcastDraft, 'audience' | 'selectedIds' | 'channels' | 'title'>,
): boolean {
  const hasAudience = draft.audience === 'all' || draft.selectedIds.size > 0
  return hasAudience && draft.channels.size > 0 && draft.title.trim().length > 0
}

/** Build the wire request from the draft. Channels are emitted in the canonical
 * server order (`channelOrder`, from the notification taxonomy) rather than
 * Set-insertion order, so the payload is deterministic. */
export function buildBroadcastRequest(
  draft: BroadcastDraft,
  channelOrder: readonly NotificationChannel[],
): BroadcastRequest {
  return {
    recipients:
      draft.audience === 'all'
        ? { mode: 'all' }
        : { mode: 'selected', user_ids: [...draft.selectedIds] },
    channels: channelOrder.filter((channel) => draft.channels.has(channel)),
    title: draft.title.trim(),
    body: draft.body.trim(),
  }
}

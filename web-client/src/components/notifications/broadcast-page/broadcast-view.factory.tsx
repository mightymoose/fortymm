import type { BroadcastViewProps } from './broadcast-view'

/** Default scenario: two searchable players, nothing picked yet, so the form is
 * not yet sendable. */
export function buildBroadcastViewProps(
  overrides: Partial<BroadcastViewProps> = {},
): BroadcastViewProps {
  return {
    recipients: [
      { id: 'u-1', username: 'nguyen.t' },
      { id: 'u-2', username: 'okafor.d' },
    ],
    recipientTotal: 2,
    recipientsLoading: false,
    search: '',
    onSearchChange: () => {},
    audience: 'selected',
    onAudienceAllChange: () => {},
    selectedIds: new Set<string>(),
    onToggleRecipient: () => {},
    selectedCount: 0,
    categories: [
      { value: 'tournament', label: 'Tournament' },
      { value: 'rating_change', label: 'Rating change' },
    ],
    category: 'tournament',
    onCategoryChange: () => {},
    title: '',
    onTitleChange: () => {},
    body: '',
    onBodyChange: () => {},
    canSend: false,
    sending: false,
    onSend: () => {},
    result: null,
    error: null,
    ...overrides,
  }
}

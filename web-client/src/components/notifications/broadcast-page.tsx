import { useState } from 'react'
import { ApiError } from '@/api/client'
import {
  useBroadcastRecipients,
  useSendBroadcast,
  type BroadcastResponse,
} from '@/api/notifications'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import { BroadcastView } from './broadcast-page/broadcast-view'
import {
  buildBroadcastRequest,
  canSendBroadcast,
  type BroadcastAudience,
} from './broadcast-page/build-broadcast-request'

function toggle<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

/** Route container for the admin broadcast tool — owns the recipient/compose
 * state and the recipients query + send mutation, and hands a pure view the
 * data + handlers. */
export function BroadcastPage() {
  const [audience, setAudience] = useState<BroadcastAudience>('selected')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [result, setResult] = useState<BroadcastResponse | null>(null)

  // Debounce so the recipient list doesn't refetch on every keystroke (the
  // pattern every other typeahead in the app uses). The input stays controlled
  // by `search`; only the query keys off the settled value.
  const debouncedSearch = useDebouncedValue(search, 300)
  const recipients = useBroadcastRecipients(debouncedSearch)
  const send = useSendBroadcast()

  const draft = { audience, selectedIds, title, body }
  const canSend = canSendBroadcast(draft) && !send.isPending
  const total = recipients.data?.total ?? 0
  const selectedCount = audience === 'all' ? total : selectedIds.size

  // Editing any field invalidates the last send's success/error banner.
  const clearResult = () => {
    setResult(null)
    send.reset()
  }

  const error = send.isError
    ? send.error instanceof ApiError && typeof send.error.detail === 'string'
      ? send.error.detail
      : "Couldn't send the broadcast. Try again."
    : null

  return (
    <BroadcastView
      recipients={recipients.data?.recipients ?? []}
      recipientTotal={total}
      recipientsLoading={recipients.isPending}
      search={search}
      onSearchChange={setSearch}
      audience={audience}
      onAudienceAllChange={(all) => {
        clearResult()
        setAudience(all ? 'all' : 'selected')
      }}
      selectedIds={selectedIds}
      onToggleRecipient={(id) => {
        clearResult()
        setAudience('selected')
        setSelectedIds((prev) => toggle(prev, id))
      }}
      selectedCount={selectedCount}
      title={title}
      onTitleChange={(value) => {
        clearResult()
        setTitle(value)
      }}
      body={body}
      onBodyChange={(value) => {
        clearResult()
        setBody(value)
      }}
      canSend={canSend}
      sending={send.isPending}
      onSend={() =>
        send.mutate(buildBroadcastRequest(draft), {
          onSuccess: (response) => setResult(response),
        })
      }
      result={result}
      error={error}
    />
  )
}

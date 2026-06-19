import { useState } from 'react'
import { ApiError } from '@/api/client'
import {
  useBroadcastRecipients,
  useNotificationTaxonomy,
  useSendBroadcast,
  type BroadcastResponse,
  type NotificationCategory,
} from '@/api/notifications'
import { useHasPermission, useSession } from '@/api/session'
import { PERM } from '@/lib/permissions'
import { AccessDenied } from '@/components/rbac/error-fallback'
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

/** Route gate for the admin broadcast tool. The server enforces
 * `notifications.broadcast` on every endpoint, but the route itself must refuse
 * to render the tool to an unauthorized user (matching the other admin
 * surfaces) — otherwise the full UI shows and the recipient search just 403s on
 * every keystroke. */
export function BroadcastPage() {
  const { isPending } = useSession()
  const canBroadcast = useHasPermission(PERM.NOTIFICATIONS_BROADCAST)
  // Wait for the session before deciding: `useHasPermission` reads false while
  // it's in flight, so checking it during load would flash access-denied.
  if (isPending) return null
  if (!canBroadcast) return <AccessDenied />
  return <BroadcastTool />
}

/** The tool itself — owns the recipient/compose state and the recipients query
 * + send mutation, and hands a pure view the data + handlers. Only mounted once
 * the gate confirms permission, so its data fetches never 403. */
function BroadcastTool() {
  const [audience, setAudience] = useState<BroadcastAudience>('selected')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<NotificationCategory>('tournament')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [result, setResult] = useState<BroadcastResponse | null>(null)

  // Debounce so the recipient list doesn't refetch on every keystroke (the
  // pattern every other typeahead in the app uses). The input stays controlled
  // by `search`; only the query keys off the settled value.
  const debouncedSearch = useDebouncedValue(search, 300)
  const recipients = useBroadcastRecipients(debouncedSearch)
  const taxonomy = useNotificationTaxonomy()
  const send = useSendBroadcast()

  // The server owns the ordered category list + labels; fall back to the
  // current category alone until the taxonomy loads so the select is never empty.
  const categories = taxonomy.data?.types.map((t) => ({
    value: t.key,
    label: t.label,
  })) ?? [{ value: category, label: category }]

  const draft = { audience, selectedIds, category, title, body }
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
      recipientsError={recipients.isError}
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
      categories={categories}
      category={category}
      onCategoryChange={(value) => {
        clearResult()
        setCategory(value)
      }}
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

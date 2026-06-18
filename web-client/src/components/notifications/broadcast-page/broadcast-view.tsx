import { CheckCircle2, Search, Send } from 'lucide-react'
import type {
  BroadcastRecipient,
  BroadcastResponse,
  NotificationItem,
} from '@/api/notifications'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { NotificationRow } from '../notification-row'
import type { BroadcastAudience } from './build-broadcast-request'

const TITLE_MAX = 100
const BODY_MAX = 280

export interface BroadcastViewProps {
  recipients: BroadcastRecipient[]
  recipientTotal: number
  recipientsLoading: boolean
  search: string
  onSearchChange: (search: string) => void
  audience: BroadcastAudience
  onAudienceAllChange: (all: boolean) => void
  selectedIds: ReadonlySet<string>
  onToggleRecipient: (id: string) => void
  selectedCount: number
  title: string
  onTitleChange: (title: string) => void
  body: string
  onBodyChange: (body: string) => void
  canSend: boolean
  sending: boolean
  onSend: () => void
  result: BroadcastResponse | null
  error: string | null
}

/** The standalone admin broadcast tool, presentational: recipient picker,
 * compose form, live preview, and send/result/error feedback. Pure — all state
 * + handlers come in as props. */
export function BroadcastView(props: BroadcastViewProps) {
  const {
    recipients,
    recipientTotal,
    recipientsLoading,
    search,
    onSearchChange,
    audience,
    onAudienceAllChange,
    selectedIds,
    onToggleRecipient,
    selectedCount,
    title,
    onTitleChange,
    body,
    onBodyChange,
    canSend,
    sending,
    onSend,
    result,
    error,
  } = props

  const hint =
    selectedCount === 0 ? 'Pick at least one recipient.' : 'Add a title.'

  return (
    <div className="grid gap-8 px-6 py-6 lg:grid-cols-[360px_1fr]">
      <section
        aria-labelledby="broadcast-recipients-heading"
        className="flex flex-col overflow-hidden rounded-[14px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-panel)]"
      >
        <div className="p-4">
          <h2 id="broadcast-recipients-heading" className="ds-overline mb-3">
            Recipients
          </h2>
          <div className="relative">
            <Search
              size={16}
              className="absolute top-1/2 left-3 -translate-y-1/2 text-[color:var(--fg-muted)]"
            />
            <Input
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search players"
              aria-label="Search players"
              className="pl-9"
            />
          </div>
        </div>

        <label className="flex cursor-pointer items-center gap-3 border-y border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-4 py-2.5">
          <Checkbox
            checked={audience === 'all'}
            onCheckedChange={(v) => onAudienceAllChange(v === true)}
            aria-label="Send to all players"
          />
          <span className="text-[13px] font-semibold text-[color:var(--fg-1)]">
            Send to all players
          </span>
          <span className="font-mono text-xs text-[color:var(--fg-3)]">
            {recipientTotal} {search ? 'matched' : 'players'}
          </span>
        </label>

        <ul className="max-h-[22rem] flex-1 overflow-y-auto">
          {recipients.map((recipient) => {
            const checked = audience === 'all' || selectedIds.has(recipient.id)
            return (
              <li key={recipient.id}>
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-3 px-4 py-2.5',
                    checked && 'bg-[rgba(255,122,26,0.07)]',
                  )}
                >
                  <Checkbox
                    checked={checked}
                    disabled={audience === 'all'}
                    onCheckedChange={() => onToggleRecipient(recipient.id)}
                    aria-label={recipient.username}
                  />
                  <span className="text-sm font-semibold text-[color:var(--fg-1)]">
                    {recipient.username}
                  </span>
                </label>
              </li>
            )
          })}
          {!recipientsLoading && recipients.length === 0 ? (
            <li className="px-4 py-10 text-center text-[13px] text-[color:var(--fg-muted)]">
              No players match “{search}”.
            </li>
          ) : null}
        </ul>

        <div className="flex items-center gap-2 border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-4 py-3">
          <span
            className="font-mono text-sm font-bold"
            style={{
              color: selectedCount ? 'var(--ball-500)' : 'var(--fg-muted)',
            }}
          >
            {selectedCount}
          </span>
          <span className="text-[13px] text-[color:var(--fg-2)]">selected</span>
        </div>
      </section>

      <div className="grid gap-9 xl:grid-cols-[1fr_340px]">
        <section aria-labelledby="broadcast-compose-heading">
          <h2 id="broadcast-compose-heading" className="ds-overline mb-3.5">
            Compose
          </h2>

          <p className="mb-6 text-xs text-[color:var(--fg-muted)]">
            Filed as tournament news — each player receives it on the channels
            they haven't muted for that category.
          </p>

          <label
            htmlFor="broadcast-title"
            className="mb-2 block text-xs font-semibold text-[color:var(--fg-3)]"
          >
            Title
          </label>
          <Input
            id="broadcast-title"
            value={title}
            maxLength={TITLE_MAX}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Short, punchy. Like a scoreboard."
          />
          <p className="mt-1 mb-5 text-right font-mono text-[11px] text-[color:var(--fg-muted)]">
            {title.length}/{TITLE_MAX}
          </p>

          <label
            htmlFor="broadcast-body"
            className="mb-2 block text-xs font-semibold text-[color:var(--fg-3)]"
          >
            Message
          </label>
          <Textarea
            id="broadcast-body"
            value={body}
            maxLength={BODY_MAX}
            rows={4}
            onChange={(e) => onBodyChange(e.target.value)}
            placeholder="What do players need to know? Keep it to the point."
          />
          <p className="mt-1 mb-6 text-right font-mono text-[11px] text-[color:var(--fg-muted)]">
            {body.length}/{BODY_MAX}
          </p>

          <Button
            type="button"
            disabled={!canSend}
            onClick={onSend}
            className="w-full gap-2"
          >
            <Send size={18} />
            {sending
              ? 'Sending…'
              : `Send to ${selectedCount} player${selectedCount === 1 ? '' : 's'}`}
          </Button>

          {error ? (
            <Alert variant="destructive" className="mt-4">
              <AlertTitle>Broadcast failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : result ? (
            <Alert className="mt-4 border-[color:rgba(0,226,154,0.3)] bg-[color:var(--bg-live-soft)]">
              <CheckCircle2 className="text-[color:var(--serve-500)]" />
              <AlertTitle>
                Queued for {result.recipients} player
                {result.recipients === 1 ? '' : 's'}
              </AlertTitle>
              <AlertDescription>
                Delivering in the background on each player's chosen channels.
              </AlertDescription>
            </Alert>
          ) : !canSend ? (
            <p className="mt-3 text-[12.5px] text-[color:var(--fg-muted)]">{hint}</p>
          ) : null}
        </section>

        <section aria-labelledby="broadcast-preview-heading">
          <h2 id="broadcast-preview-heading" className="ds-overline mb-3.5">
            Preview
          </h2>
          <BroadcastPreview title={title} body={body} />
        </section>
      </div>
    </div>
  )
}

function BroadcastPreview({ title, body }: { title: string; body: string }) {
  const safeTitle = title || 'Notification title'
  const safeBody = body || 'Your message shows up here.'
  const previewNotification: NotificationItem = {
    id: 'preview',
    category: 'tournament',
    title: safeTitle,
    body: safeBody,
    link: null,
    action_label: null,
    delta: null,
    read_at: null,
    created_at: '2026-06-17T12:00:00.000Z',
  }

  return (
    <div>
      <p className="mb-2 font-mono text-[11px] tracking-wider text-[color:var(--fg-muted)]">
        IN-APP / BELL
      </p>
      <div className="overflow-hidden rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-panel)]">
        <NotificationRow notification={previewNotification} compact />
      </div>
    </div>
  )
}

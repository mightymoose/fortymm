import type {
  NotificationChannel,
  NotificationPreferences,
  NotificationTaxonomy,
} from '@/api/notifications'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { CATEGORY_VISUAL, CHANNEL_VISUAL } from '../notification-meta'
import { ChannelSetupNudge } from './channel-setup-nudge'
import { channelSetupNudge } from './channel-setup-nudge-content'

export interface PreferencesViewProps {
  preferences: NotificationPreferences
  /** Server-owned display labels for categories + channels. */
  taxonomy: NotificationTaxonomy
  /** The address awaiting confirmation, if any (from the session). Switches the
   * email card + nudge from "add an email" to "confirm your email". */
  pendingEmail?: string | null
  onToggleChannel: (channel: NotificationChannel, enabled: boolean) => void
  onToggleCell: (
    category: NotificationPreferences['categories'][number]['category'],
    channel: NotificationChannel,
    enabled: boolean,
  ) => void
}

/** The notifications settings page: channel "sign-up" cards plus the
 * per-category × per-channel mute matrix. Pure — state + handlers come in. */
export function PreferencesView({
  preferences,
  taxonomy,
  pendingEmail = null,
  onToggleChannel,
  onToggleCell,
}: PreferencesViewProps) {
  const channels = preferences.channels
  const channelByKey = new Map(channels.map((c) => [c.channel, c]))
  const channelLabel = new Map(taxonomy.channels.map((c) => [c.key, c.label]))
  const categoryLabel = new Map(taxonomy.types.map((t) => [t.key, t.label]))

  return (
    <div className="mx-auto max-w-[840px] px-6 pt-9 pb-20">
      <p className="ds-overline mb-2">● Settings</p>
      <h1 className="font-display mb-1.5 text-[44px] leading-none text-[color:var(--fg-1)]">
        NOTIFICATIONS
      </h1>
      <p className="mb-7 max-w-[560px] text-[15px] text-[color:var(--fg-3)]">
        Pick how we reach you. No marketing, ever — just your matches, ratings
        and draws.
      </p>

      <p className="ds-overline mb-3.5">Where we reach you</p>
      <div className="mb-9 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {channels.map((channel) => {
          const { Icon } = CHANNEL_VISUAL[channel.channel]
          const label = channelLabel.get(channel.channel) ?? channel.channel
          const interactive = !channel.locked && channel.available
          const nudge =
            channel.available && channel.setup_required
              ? channelSetupNudge(channel.channel, pendingEmail)
              : undefined
          // The server's email destination ("Add an email in settings") is
          // wrong once an address is on file but unconfirmed — reflect the
          // pending state instead.
          const destination =
            channel.channel === 'email' && pendingEmail
              ? 'Pending — check your inbox'
              : channel.destination
          return (
            <div key={channel.channel} className="min-w-0">
              <div
                className={cn(
                  'flex items-center gap-3 rounded-xl border bg-[color:var(--bg-card)] p-4 transition-opacity',
                  channel.enabled
                    ? 'border-[color:var(--border-default)]'
                    : 'border-[color:var(--border-subtle)] opacity-70',
                )}
              >
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-[10px]"
                  style={{
                    background: channel.enabled
                      ? 'rgba(255,122,26,0.12)'
                      : 'var(--bg-raised)',
                    color: channel.enabled ? 'var(--ball-500)' : 'var(--fg-3)',
                  }}
                >
                  <Icon size={20} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold text-[color:var(--fg-1)]">
                    {label}
                  </span>
                  <span className="block truncate text-xs text-[color:var(--fg-3)]">
                    {destination}
                  </span>
                </span>
                <Switch
                  checked={channel.enabled}
                  disabled={!interactive}
                  onCheckedChange={(value) =>
                    onToggleChannel(channel.channel, value === true)
                  }
                  aria-label={`${label} notifications`}
                />
              </div>
              {nudge && <ChannelSetupNudge {...nudge} />}
            </div>
          )
        })}
      </div>

      <div className="mb-3.5 flex items-baseline gap-3">
        <p className="ds-overline">What you get, where</p>
        <span className="text-xs text-[color:var(--fg-muted)]">
          Tap a cell to mute that channel for a category.
        </span>
      </div>

      <div className="overflow-hidden rounded-[14px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-panel)]">
        <div
          className="grid items-center border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]"
          style={{ gridTemplateColumns: '1.6fr repeat(4, 1fr)' }}
        >
          <div className="ds-overline px-4 py-3.5">Category</div>
          {channels.map((channel) => {
            const { Icon } = CHANNEL_VISUAL[channel.channel]
            const label = channelLabel.get(channel.channel) ?? channel.channel
            return (
              <div
                key={channel.channel}
                className="flex flex-col items-center gap-1.5 py-2.5"
                style={{ opacity: channel.enabled ? 1 : 0.6 }}
              >
                <Icon size={17} className="text-[color:var(--fg-2)]" />
                <span className="font-mono text-[10px] tracking-wide text-[color:var(--fg-3)] uppercase">
                  {label}
                </span>
              </div>
            )
          })}
        </div>

        {preferences.categories.map((row, i) => {
          const visual = CATEGORY_VISUAL[row.category]
          const { Icon } = visual
          const rowLabel = categoryLabel.get(row.category) ?? row.category
          return (
            <div
              key={row.category}
              className={cn(
                'grid items-center',
                i < preferences.categories.length - 1 &&
                  'border-b border-[color:var(--ink-800)]',
              )}
              style={{ gridTemplateColumns: '1.6fr repeat(4, 1fr)' }}
            >
              <div className="flex items-center gap-3 px-4 py-3.5">
                <span
                  className="flex size-8 shrink-0 items-center justify-center rounded-[9px]"
                  style={{ background: visual.tint, color: visual.color }}
                >
                  <Icon size={17} />
                </span>
                <span className="text-sm font-semibold text-[color:var(--fg-1)]">
                  {rowLabel}
                </span>
              </div>
              {row.cells.map((cell) => {
                const master = channelByKey.get(cell.channel)
                const masterOn = master?.enabled ?? false
                const available = master?.available ?? false
                const disabled = cell.locked || !available || !masterOn
                return (
                  <div
                    key={cell.channel}
                    className="flex items-center justify-center py-3.5"
                  >
                    <Checkbox
                      checked={cell.enabled}
                      disabled={disabled}
                      onCheckedChange={(value) =>
                        onToggleCell(row.category, cell.channel, value === true)
                      }
                      aria-label={`${rowLabel} via ${
                        channelLabel.get(cell.channel) ?? cell.channel
                      }`}
                    />
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      <p className="mt-4 text-[12.5px] text-[color:var(--fg-muted)]">
        Match reminders always come through in-app and push — we won't let you
        miss a call to the table.
      </p>
    </div>
  )
}

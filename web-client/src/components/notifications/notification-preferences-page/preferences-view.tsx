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

type ChannelState = NotificationPreferences['channels'][number]

/** The channel is deliverable *in principle* but this user hasn't finished the
 * prerequisite — no confirmed email, no registered push device. The server
 * computes it and hands us the way out in `destination` / the setup nudge. */
function isAwaitingSetup(channel: ChannelState) {
  return channel.available && channel.setup_required
}

/** Can a notification actually reach the user on this channel right now? Both
 * server flags have to say yes: `available` (we can deliver on it at all — SMS
 * can't) *and* not `setup_required` (this user has somewhere for it to land).
 *
 * Everything the switches claim keys off this, not off `available` alone. An
 * "on" switch beside "No devices yet" promises a delivery path that does not
 * exist (#892), so a channel awaiting setup renders **off and disabled** —
 * `enabled` is the user's stored intent, which we can't honour yet. The nudge
 * under the card is the way out, and it's why a disabled control is the right
 * shape here rather than the read-only view of ADR 0015: this isn't a
 * permission gate, it's a prerequisite the user can clear themselves, and the
 * nudge supplies the "why" a bare disabled control would withhold. */
function isDeliverable(channel: ChannelState) {
  return channel.available && !channel.setup_required
}

/** Is this channel *effectively* on — the user wants it **and** we can deliver?
 *
 * The one place that question is answered. It used to be spelled three ways (the
 * card, the matrix header, the matrix cell), and the spellings had already
 * drifted: the card asked only whether setup was pending, so a channel the server
 * marked unavailable-but-enabled would have lit its switch on — #892 again, in
 * the half of the component #892 didn't touch. A rule written once cannot drift. */
function isOn(channel: ChannelState) {
  return channel.enabled && isDeliverable(channel)
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
      {/* Masonry-style columns rather than a grid: each card carries an
          optional setup nudge of its own height, and a row-aligned grid would
          leave a tall gap beside any card whose neighbour has a nudge. Columns
          let each card+nudge unit pack independently. */}
      <div className="mb-9 columns-1 gap-3 sm:columns-2">
        {channels.map((channel) => {
          const { Icon } = CHANNEL_VISUAL[channel.channel]
          const label = channelLabel.get(channel.channel) ?? channel.channel
          const awaitingSetup = isAwaitingSetup(channel)
          // A channel with nowhere to deliver reads as off, whatever the stored
          // master says — and can't be switched on until setup is done.
          const on = isOn(channel)
          const interactive = !channel.locked && isDeliverable(channel)
          const nudge = awaitingSetup
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
            <div key={channel.channel} className="mb-3 break-inside-avoid">
              <div
                className={cn(
                  'flex items-center gap-3 rounded-xl border bg-[color:var(--bg-card)] p-4 transition-opacity',
                  on
                    ? 'border-[color:var(--border-default)]'
                    : 'border-[color:var(--border-subtle)] opacity-70',
                )}
              >
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-[10px]"
                  style={{
                    background: on
                      ? 'rgba(255,122,26,0.12)'
                      : 'var(--bg-raised)',
                    color: on ? 'var(--ball-500)' : 'var(--fg-3)',
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
                  checked={on}
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
            const on = isOn(channel)
            return (
              <div
                key={channel.channel}
                className="flex flex-col items-center gap-1.5 py-2.5"
                style={{ opacity: on ? 1 : 0.6 }}
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
                // Same rule as the master switch above, one level down: a cell
                // can only claim delivery its channel can actually make. With
                // the channel awaiting setup its master is off, so the cell
                // reads off and can't be flipped — including the cells locked
                // on (match reminders), which is exactly the promise the channel
                // can't keep yet.
                const canDeliver = master ? isDeliverable(master) : false
                const masterOn = master ? isOn(master) : false
                const disabled = cell.locked || !masterOn
                return (
                  <div
                    key={cell.channel}
                    className="flex items-center justify-center py-3.5"
                  >
                    <Checkbox
                      checked={cell.enabled && canDeliver}
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

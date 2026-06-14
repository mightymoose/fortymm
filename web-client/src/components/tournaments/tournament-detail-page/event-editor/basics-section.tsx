import { Input } from '@/components/ui/input'

import { DRAW_TYPE_OPTIONS, FORMAT_OPTIONS } from '../../data/options'
import type { DrawType, EventFormat, TournamentEvent } from '../../data/types'
import { Field } from '../../field'
import { SectionHeader } from '../section-header'
import { OptionSelect } from './option-select'

export interface BasicsSectionProps {
  event: TournamentEvent
  onChange: (next: TournamentEvent) => void
}

/** The event editor's "Basics" tab: name, format, draw type, caps, and the
 * time-slot window. */
export const BasicsSection = ({ event, onChange }: BasicsSectionProps) => {
  const set = (patch: Partial<TournamentEvent>) => onChange({ ...event, ...patch })
  const setSlot = (patch: Partial<TournamentEvent['slot']>) =>
    set({ slot: { ...event.slot, ...patch } })

  return (
    <div className="flex flex-col gap-5">
      <SectionHeader
        title="The basics"
        subtitle="Name it, decide the format, set the window."
      />

      <Field label="Event name" required>
        {(id) => (
          <Input
            id={id}
            autoFocus
            value={event.name}
            placeholder="Open Singles"
            onChange={(e) => set({ name: e.target.value })}
          />
        )}
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Format" required>
          {() => (
            <OptionSelect
              ariaLabel="Format"
              value={event.format}
              options={FORMAT_OPTIONS}
              onChange={(v) => set({ format: v as EventFormat })}
            />
          )}
        </Field>
        <Field label="Draw type">
          {() => (
            <OptionSelect
              ariaLabel="Draw type"
              value={event.drawType}
              options={DRAW_TYPE_OPTIONS}
              onChange={(v) => set({ drawType: v as DrawType })}
            />
          )}
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Player limit" hint="Hard cap. Waitlist opens past this.">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={2}
              max={512}
              value={event.maxPlayers}
              onChange={(e) => set({ maxPlayers: Number(e.target.value) })}
            />
          )}
        </Field>
        <Field label="Entry fee">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              value={event.entryFee}
              onChange={(e) => set({ entryFee: Number(e.target.value) })}
            />
          )}
        </Field>
      </div>

      <div className="my-1 flex items-center gap-3">
        <span className="text-[11px] font-semibold tracking-[0.14em] text-[color:var(--fg-3)] uppercase">
          Time slot
        </span>
        <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
      </div>

      <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-4">
        <Field label="Date">
          {(id) => (
            <Input
              id={id}
              type="date"
              value={event.slot.date}
              onChange={(e) => setSlot({ date: e.target.value })}
            />
          )}
        </Field>
        <Field label="Start">
          {(id) => (
            <Input
              id={id}
              type="time"
              className="font-mono"
              value={event.slot.start}
              onChange={(e) => setSlot({ start: e.target.value })}
            />
          )}
        </Field>
        <Field label="End">
          {(id) => (
            <Input
              id={id}
              type="time"
              className="font-mono"
              value={event.slot.end}
              onChange={(e) => setSlot({ end: e.target.value })}
            />
          )}
        </Field>
      </div>
    </div>
  )
}

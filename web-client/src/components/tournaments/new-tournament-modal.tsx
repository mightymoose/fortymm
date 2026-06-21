import { useEffect } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { Check } from 'lucide-react'

import { ApiError } from '@/api/client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

import { emptyTournament } from './data/helpers'
import type { Tournament } from './data/types'
import { Field } from './field'

export interface NewTournamentModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Persist the draft. May be async — the modal awaits it, closes itself only
   * on success, and surfaces a rejection inline (the dialog stays open) rather
   * than closing over a silent failure. */
  onCreate: (draft: Omit<Tournament, 'id'>) => void | Promise<void>
}

// Mirrors the server's `tournaments.name` constraint (VARCHAR(255)) so the
// over-long name is caught client-side with an inline message instead of a
// bare 422 (#614).
const NAME_MAX = 255

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { message: 'Name is required.' })
    .max(NAME_MAX, {
      message: `Name must be ${NAME_MAX} characters or fewer.`,
    }),
  venue: z.string(),
  street: z.string(),
  city: z.string(),
  region: z.string(),
  postal: z.string(),
})

type FormValues = z.infer<typeof schema>

const DEFAULT_VALUES: FormValues = {
  name: '',
  venue: '',
  street: '',
  city: '',
  region: '',
  postal: '',
}

/** "New tournament" dialog — captures a name (required) and optional venue
 * address. Dates are derived from events, so they're set later. */
export const NewTournamentModal = ({
  open,
  onOpenChange,
  onCreate,
}: NewTournamentModalProps) => {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: DEFAULT_VALUES,
    mode: 'onChange',
  })
  const {
    register,
    formState: { errors },
  } = form

  // Reset to a blank draft each time the dialog (re)opens — the modal stays
  // mounted, so without this a second open would show the prior attempt.
  useEffect(() => {
    if (open) form.reset(DEFAULT_VALUES)
  }, [open, form])

  const submit = form.handleSubmit(async (values) => {
    const base = emptyTournament()
    try {
      await onCreate({
        ...base,
        name: values.name,
        address: {
          ...base.address,
          venue: values.venue.trim(),
          street: values.street.trim(),
          city: values.city.trim(),
          region: values.region.trim(),
          postal: values.postal.trim(),
        },
      })
      onOpenChange(false)
    } catch (err) {
      // The name is the only constrained field, so a 4xx here is a name the
      // server rejected — show it on the field. Anything else is unexpected;
      // toast it and keep the dialog open so the entry isn't lost.
      if (err instanceof ApiError && (err.status === 422 || err.status === 409)) {
        form.setError('name', {
          type: 'server',
          message: err.detail ?? 'The server rejected this name.',
        })
        return
      }
      toast.error("Couldn't create the tournament", {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>New tournament</DialogTitle>
          <DialogDescription>
            You'll set dates when you add events.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} noValidate>
          <div className="flex flex-col gap-3.5">
            <Field
              label="Name"
              required
              error={!!errors.name}
              hint={errors.name?.message}
            >
              {(id) => (
                <Input
                  id={id}
                  autoFocus
                  aria-invalid={!!errors.name}
                  placeholder="Spring Open 2026"
                  {...register('name')}
                />
              )}
            </Field>

            <div className="my-1 flex items-center gap-3">
              <span className="text-[11px] font-semibold tracking-[0.14em] text-[color:var(--fg-3)] uppercase">
                Venue
              </span>
              <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
            </div>

            <Field label="Venue name">
              {(id) => (
                <Input id={id} placeholder="Berkeley TT Club" {...register('venue')} />
              )}
            </Field>
            <Field label="Street">
              {(id) => (
                <Input id={id} placeholder="2727 Milvia St" {...register('street')} />
              )}
            </Field>
            <div className="grid grid-cols-[2fr_1fr_1fr] gap-3">
              <Field label="City">
                {(id) => (
                  <Input id={id} placeholder="Berkeley" {...register('city')} />
                )}
              </Field>
              <Field label="Region">
                {(id) => <Input id={id} placeholder="CA" {...register('region')} />}
              </Field>
              <Field label="Postal">
                {(id) => (
                  <Input
                    id={id}
                    placeholder="94703"
                    className="font-mono"
                    {...register('postal')}
                  />
                )}
              </Field>
            </div>
          </div>

          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            {/* Not gated on form validity: handleSubmit already blocks an
                invalid submit and renders the inline error, so an empty/over-long
                name surfaces a message instead of a dead, disabled button. */}
            <Button type="submit" disabled={form.formState.isSubmitting}>
              <Check size={16} />
              Create tournament
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

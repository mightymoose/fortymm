import { useMemo } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { ApiError } from '@/api/client'
import { useUpdateUsername } from '@/api/session'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'

// Mirror api/app/schemas/session.py USERNAME_PATTERN. Client-side validation
// is for fast feedback; the server still enforces the same rules.
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,38}[a-z0-9])?$/
const USERNAME_MIN = 3
const USERNAME_MAX = 40

function buildSchema(currentUsername: string) {
  return z.object({
    username: z
      .string()
      .trim()
      .min(USERNAME_MIN, { message: `At least ${USERNAME_MIN} characters.` })
      .max(USERNAME_MAX, { message: `No more than ${USERNAME_MAX} characters.` })
      .refine((v) => USERNAME_RE.test(v), {
        message:
          'Lowercase letters, numbers, dots, hyphens and underscores. Must start and end with a letter or number.',
      })
      .refine((v) => v !== currentUsername, {
        message: "That's already your username.",
      }),
  })
}

type FormValues = z.infer<ReturnType<typeof buildSchema>>

export function ChangeUsernameDialog({
  open,
  onOpenChange,
  currentUsername,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentUsername: string
}) {
  const schema = useMemo(() => buildSchema(currentUsername), [currentUsername])
  const updateUsername = useUpdateUsername()
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { username: currentUsername },
    mode: 'onChange',
  })

  const handleSubmit = form.handleSubmit(async (values) => {
    try {
      await updateUsername.mutateAsync(values.username)
      onOpenChange(false)
      form.reset({ username: values.username })
      toast.success('Username updated.')
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 422)) {
        form.setError('username', {
          type: 'server',
          message: err.detail ?? 'Server rejected this username.',
        })
        return
      }
      toast.error("Couldn't update username", {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset({ username: currentUsername })
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change username</DialogTitle>
          <DialogDescription>
            This is how other players will find you. You can change it again later.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={handleSubmit} noValidate>
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Username</FormLabel>
                  <FormControl>
                    <Input
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                      style={{ fontFamily: 'var(--font-mono)' }}
                      {...field}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value.toLowerCase().replace(/\s/g, ''),
                        )
                      }
                    />
                  </FormControl>
                  <FormDescription>
                    3–40 characters. Lowercase letters, numbers, dots, hyphens, underscores.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter style={{ marginTop: 16 }}>
              <Button
                variant="outline"
                type="button"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={updateUsername.isPending}>
                {updateUsername.isPending ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

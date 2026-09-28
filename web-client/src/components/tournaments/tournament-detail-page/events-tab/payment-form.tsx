import { zodResolver } from '@hookform/resolvers/zod'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { loadStripe } from '@stripe/stripe-js'
import { useId, useMemo, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { declineMessage } from './decline-message'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

/** Mirrors the server: an email address, or empty for "no receipt email". */
const receiptSchema = z.object({
  receiptAddress: z
    .string()
    .trim()
    .max(254, 'Enter an email address of 254 characters or fewer.')
    .refine((value) => value === '' || z.email().safeParse(value).success, {
      message: 'Enter a valid email address, or leave it empty.',
    }),
})
type ReceiptValues = z.infer<typeof receiptSchema>

export interface PaymentFormProps {
  publishableKey: string
  clientSecret: string
  totalCents: number
  /** Where Stripe sends the player back after a 3-D Secure redirect. */
  returnUrl: string
  /** The receipt address the field starts with. */
  defaultReceiptAddress: string
  /** Whether the field is marked optional: it starts empty when the account
   * has no confirmed email. */
  receiptOptional: boolean
  /** The server's safe code for the last decline, if the card was declined. */
  lastErrorCode: string | null
  declined: boolean
  saveReceiptAddress: (address: string | null) => Promise<unknown>
  /** Runs after the receipt address saves and before the card confirms. */
  onConfirmStarted: () => void
  /** Runs after Stripe answers, whatever it said. */
  onConfirmSettled: (outcome: 'confirmed' | 'declined' | 'incomplete') => void
}

/**
 * The card half of the checkout panel: Stripe's Payment Element (card only),
 * the optional receipt address, and one Pay button that names the total.
 */
export function PaymentForm(props: PaymentFormProps) {
  const stripe = useMemo(() => loadStripe(props.publishableKey), [props.publishableKey])
  return (
    <Elements stripe={stripe} options={{ clientSecret: props.clientSecret }}>
      <PaymentFormFields {...props} />
    </Elements>
  )
}

function PaymentFormFields({
  totalCents,
  returnUrl,
  defaultReceiptAddress,
  receiptOptional,
  lastErrorCode,
  declined,
  saveReceiptAddress,
  onConfirmStarted,
  onConfirmSettled,
}: PaymentFormProps) {
  const stripe = useStripe()
  const elements = useElements()
  const receiptId = useId()
  const confirming = useRef(false)
  const form = useForm<ReceiptValues>({
    resolver: zodResolver(receiptSchema),
    defaultValues: { receiptAddress: defaultReceiptAddress },
  })
  const receiptError = form.formState.errors.receiptAddress?.message

  const pay = async ({ receiptAddress }: ReceiptValues) => {
    // A second press while the first is in flight must not confirm twice.
    if (confirming.current || !stripe || !elements) return
    confirming.current = true
    try {
      try {
        await saveReceiptAddress(receiptAddress === '' ? null : receiptAddress)
      } catch {
        form.setError('receiptAddress', {
          type: 'server',
          message: 'We couldn’t save your receipt address. Try again.',
        })
        return
      }
      onConfirmStarted()
      const result = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl },
        redirect: 'if_required',
      })
      if (!result.error) onConfirmSettled('confirmed')
      // An incomplete card form is Stripe's to explain, inside the element.
      else if (result.error.type === 'validation_error') onConfirmSettled('incomplete')
      else onConfirmSettled('declined')
    } finally {
      confirming.current = false
    }
  }

  return (
    <form onSubmit={(event) => void form.handleSubmit(pay)(event)} noValidate className="flex flex-col gap-4">
      <div>
        <div className="flex items-baseline justify-between">
          <Label htmlFor={receiptId}>Receipt email</Label>
          {receiptOptional && (
            <span className="text-xs text-muted-foreground">Optional</span>
          )}
        </div>
        <Input
          id={receiptId}
          type="email"
          autoComplete="email"
          className="mt-1.5"
          aria-invalid={receiptError ? true : undefined}
          aria-describedby={`${receiptId}-hint`}
          {...form.register('receiptAddress')}
        />
        {receiptError ? (
          <p className="mt-1.5 text-xs text-[color:var(--loss)]">{receiptError}</p>
        ) : (
          <p id={`${receiptId}-hint`} className="mt-1.5 text-xs text-muted-foreground">
            We send the receipt here. Leave it empty for no receipt email.
          </p>
        )}
      </div>
      <PaymentElement
        options={{
          layout: 'tabs',
          wallets: { applePay: 'never', googlePay: 'never' },
        }}
      />
      {declined && (
        <p role="alert" className="text-sm font-medium text-[color:var(--loss)]">
          {declineMessage(lastErrorCode)}
        </p>
      )}
      <Button type="submit" size="lg" disabled={form.formState.isSubmitting}>
        Pay {usd.format(totalCents / 100)}
      </Button>
    </form>
  )
}

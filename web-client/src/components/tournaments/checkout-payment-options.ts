import type { StripePaymentElementOptions } from '@stripe/stripe-js'

export const cardPaymentElementOptions = {
  layout: 'tabs',
  wallets: { applePay: 'never', googlePay: 'never' },
  paymentMethodOrder: ['card'],
} satisfies StripePaymentElementOptions

/** The player-facing message for a declined card, keyed by the server's safe
 * `last_error_code` (#1809). Never Stripe's own error text. */
const DECLINE_MESSAGES: Record<string, string> = {
  card_declined: 'Your card was declined. Try another card.',
  insufficient_funds: 'Your card was declined. Try another card.',
  expired_card: 'Your card has expired. Try another card.',
  incorrect_cvc: 'The security code is incorrect. Check it and try again.',
  incorrect_number: 'The card number is incorrect. Check it and try again.',
  processing_error: 'We couldn’t process your card. Try again.',
}

/** `card_error`, any unknown code and a missing code all get this. */
export const GENERIC_DECLINE = 'Your card couldn’t be charged. Try another card.'

export function declineMessage(code: string | null): string {
  return (code !== null && DECLINE_MESSAGES[code]) || GENERIC_DECLINE
}

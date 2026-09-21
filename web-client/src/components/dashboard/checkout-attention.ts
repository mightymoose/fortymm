import type { CheckoutAttentionItem } from '@/api/dashboard'

export function checkoutAttentionCopy(item: CheckoutAttentionItem): string {
  if (item.kind === 'needs_review') return 'Payment needs review'
  if (item.kind === 'checking') return 'Payment is still being confirmed'
  return 'Finish checkout'
}

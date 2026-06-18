import {
  Bell,
  CheckCircle2,
  Clock,
  Flag,
  Mail,
  MessageSquare,
  Smartphone,
  Swords,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'
import type { components } from '@/api/schema'

export type NotificationCategory = components['schemas']['NotificationCategory']
export type NotificationChannel = components['schemas']['NotificationChannel']

export interface CategoryVisual {
  Icon: LucideIcon
  /** Icon stroke colour (a FortyMM token). */
  color: string
  /** Soft tint behind the category icon badge. */
  tint: string
}

// The product's visual taxonomy — the icon and the one accent colour each
// category "owns". Labels + display order now come from the server taxonomy
// (`/v1/notification-taxonomy`); only the look stays a frontend concern, since
// icons and colour tokens can't live in the DB.
export const CATEGORY_VISUAL: Record<NotificationCategory, CategoryVisual> = {
  match_reminder: {
    Icon: Clock,
    color: 'var(--ball-500)',
    tint: 'rgba(255, 122, 26, 0.12)',
  },
  rating_change: {
    Icon: TrendingUp,
    color: 'var(--serve-500)',
    tint: 'rgba(0, 226, 154, 0.14)',
  },
  tournament: {
    Icon: Flag,
    color: 'var(--info)',
    tint: 'rgba(111, 181, 255, 0.14)',
  },
  opponent: {
    Icon: Swords,
    color: 'var(--ball-500)',
    tint: 'rgba(255, 122, 26, 0.12)',
  },
  result_confirm: {
    Icon: CheckCircle2,
    color: 'var(--warn)',
    tint: 'rgba(255, 196, 61, 0.14)',
  },
}

export interface ChannelVisual {
  Icon: LucideIcon
}

// Per-channel icon. Labels + order come from the server taxonomy.
export const CHANNEL_VISUAL: Record<NotificationChannel, ChannelVisual> = {
  in_app: { Icon: Bell },
  push: { Icon: Smartphone },
  email: { Icon: Mail },
  sms: { Icon: MessageSquare },
}

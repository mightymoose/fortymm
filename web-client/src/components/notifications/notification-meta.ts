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

export interface CategoryMeta {
  /** Full label for the preferences matrix and settings. */
  label: string
  /** Compact label for the feed filter pills. */
  short: string
  Icon: LucideIcon
  /** Icon stroke colour (a FortyMM token). */
  color: string
  /** Soft tint behind the category icon badge. */
  tint: string
}

// The product's visual taxonomy — labels, icons, and the one accent colour each
// category "owns". Mirrors the design's NCATS. Kept on the client (the server
// ships only the category key) so the look stays a frontend concern.
export const CATEGORY_META: Record<NotificationCategory, CategoryMeta> = {
  match_reminder: {
    label: 'Match reminders',
    short: 'Match',
    Icon: Clock,
    color: 'var(--ball-500)',
    tint: 'rgba(255, 122, 26, 0.12)',
  },
  rating_change: {
    label: 'Rating changes',
    short: 'Rating',
    Icon: TrendingUp,
    color: 'var(--serve-500)',
    tint: 'rgba(0, 226, 154, 0.14)',
  },
  tournament: {
    label: 'Tournament news',
    short: 'Tourney',
    Icon: Flag,
    color: 'var(--info)',
    tint: 'rgba(111, 181, 255, 0.14)',
  },
  opponent: {
    label: 'Challenges & friends',
    short: 'Social',
    Icon: Swords,
    color: 'var(--ball-500)',
    tint: 'rgba(255, 122, 26, 0.12)',
  },
  result_confirm: {
    label: 'Score confirmations',
    short: 'Scores',
    Icon: CheckCircle2,
    color: 'var(--warn)',
    tint: 'rgba(255, 196, 61, 0.14)',
  },
}

// Display order for the feed filter pills and the preferences matrix rows.
export const CATEGORY_ORDER: NotificationCategory[] = [
  'match_reminder',
  'rating_change',
  'tournament',
  'opponent',
  'result_confirm',
]

export interface ChannelMeta {
  label: string
  Icon: LucideIcon
}

// Mirrors the design's NCHANNELS.
export const CHANNEL_META: Record<NotificationChannel, ChannelMeta> = {
  in_app: { label: 'In-app', Icon: Bell },
  push: { label: 'Push', Icon: Smartphone },
  email: { label: 'Email', Icon: Mail },
  sms: { label: 'SMS', Icon: MessageSquare },
}

export const CHANNEL_ORDER: NotificationChannel[] = [
  'in_app',
  'push',
  'email',
  'sms',
]

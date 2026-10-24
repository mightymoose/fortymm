import { Link, useParams } from '@tanstack/react-router'
import type { ComponentType } from 'react'
import { Icon } from '../../components/Icon'
import '../../styles/options.css'
import { findOption, type Option, type OptionSlug } from './catalog'
import { HomeClub } from './HomeClub'
import { HomeJoin } from './HomeJoin'
import { HomeOrganizer } from './HomeOrganizer'
import { HomeToday } from './HomeToday'
import { HomeWelcome } from './HomeWelcome'
import { LoadingPreview } from './LoadingPreview'
import {
  LoadingFrame,
  LoadingLanding,
  LoadingProgress,
  LoadingStill,
  type LoadingViewProps,
} from './loadingViews'

const loading =
  (View: ComponentType<LoadingViewProps>) =>
  ({ option }: { option: Option }) => <LoadingPreview option={option} View={View} />

const pages: Record<OptionSlug, ComponentType<{ option: Option }>> = {
  'home-welcome': HomeWelcome,
  'home-today': HomeToday,
  'home-join': HomeJoin,
  'home-organizer': HomeOrganizer,
  'home-club': HomeClub,
  'loading-still': loading(LoadingStill),
  'loading-progress': loading(LoadingProgress),
  'loading-frame': loading(LoadingFrame),
  'loading-landing': loading(LoadingLanding),
}

// One option preview: a breadcrumb back to the list, the option's pitch,
// then the option itself.
export function OptionPage() {
  const { option: slug } = useParams({ from: '/options/$option' })
  const option = findOption(slug)!
  const Page = pages[option.slug as OptionSlug]
  return (
    <>
      <div className="opt-bar">
        <nav className="fm-crumbs" aria-label="Breadcrumb">
          <Link to="/options" activeOptions={{ exact: true }}>
            Options
          </Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{option.title}</span>
        </nav>
        <p className="fm-notice">
          <Icon name="info" />
          <span>{option.pitch}</span>
        </p>
      </div>
      <Page option={option} />
    </>
  )
}

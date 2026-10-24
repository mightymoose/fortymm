import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { isTestMode } from '../testMode'
import { Button } from './Button'
import { Icon } from './Icon'

// What a slide carries, so it reads out as "2 of 5".
export type SlideProps = {
  role: 'group'
  'aria-roledescription': 'slide'
  'aria-label': string
}

// Where the track has scrolled to: which slides show, and whether it can
// step back or on.
type Position = { text: string; atStart: boolean; atEnd: boolean }

// The gap between slides in `.fm-carousel__track`.
const gap = 16

// The first slide at or before the track's left edge, as kit.js finds it.
function firstShown(track: HTMLElement): number {
  let first = 0
  ;[...track.children].forEach((slide, index) => {
    if ((slide as HTMLElement).offsetLeft <= track.scrollLeft + 4) first = index
  })
  return first
}

function measure(track: HTMLElement): Position {
  const slides = [...track.children] as HTMLElement[]
  if (!slides.length) return { text: '', atStart: true, atEnd: true }
  const first = firstShown(track)
  const perView = Math.max(1, Math.round(track.clientWidth / (slides[0].offsetWidth + gap)))
  const last = Math.min(slides.length, first + perView)
  return {
    text: `${last > first + 1 ? `${first + 1}–${last}` : first + 1} of ${slides.length}`,
    atStart: track.scrollLeft <= 2,
    atEnd: track.scrollLeft + track.clientWidth >= track.scrollWidth - 2,
  }
}

// A short row of peers to browse, as kit.js's FM.carousel has it, styled by
// `.fm-carousel` in styles/kit.css: `title`, the buttons that step one slide
// back or on with how many are in view between them, then the track. It
// never moves on its own. The track also scrolls by touch, trackpad or the
// arrow keys once it has focus, and snaps to a slide. `slides` draws each of
// `items`, and must spread the SlideProps it gets on its outer element.
export function Carousel<Item>({
  title,
  previousLabel,
  nextLabel,
  trackLabel,
  items,
  slides,
}: {
  title: string
  previousLabel: string
  nextLabel: string
  trackLabel: string
  items: readonly Item[]
  slides: (item: Item, slide: SlideProps) => ReactNode
}) {
  const titleId = useId()
  const track = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<Position | null>(null)

  useEffect(() => {
    const element = track.current!
    const update = () => setPosition(measure(element))
    // kit.js waits for scrolling to stop before it counts again.
    let timer: ReturnType<typeof setTimeout>
    const onScroll = () => {
      clearTimeout(timer)
      timer = setTimeout(update, 60)
    }
    update()
    element.addEventListener('scroll', onScroll)
    window.addEventListener('resize', update)
    return () => {
      clearTimeout(timer)
      element.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', update)
    }
  }, [])

  const go = (by: number) => {
    const element = track.current!
    const slideElements = [...element.children] as HTMLElement[]
    const to = Math.max(0, Math.min(slideElements.length - 1, firstShown(element) + by))
    const still =
      isTestMode() || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollTo({ left: slideElements[to].offsetLeft, behavior: still ? 'auto' : 'smooth' })
  }

  return (
    <section className="fm-carousel" aria-roledescription="carousel" aria-labelledby={titleId}>
      <div className="fm-carousel__head">
        <h4 className="fm-section-title" id={titleId}>
          {title}
        </h4>
        <div className="fm-carousel__ctrl">
          <Button
            variant="ghost"
            size="sm"
            icon
            aria-label={previousLabel}
            disabled={position?.atStart}
            onClick={() => go(-1)}
          >
            <Icon name="left" />
          </Button>
          <span className="fm-carousel__pos" aria-live="polite">
            {position?.text}
          </span>
          <Button
            variant="ghost"
            size="sm"
            icon
            aria-label={nextLabel}
            disabled={position?.atEnd}
            onClick={() => go(1)}
          >
            <Icon name="right" />
          </Button>
        </div>
      </div>
      <div className="fm-carousel__track" ref={track} tabIndex={0} aria-label={trackLabel}>
        {items.map((item, index) => (
          <Fragment key={index}>
            {slides(item, {
              role: 'group',
              'aria-roledescription': 'slide',
              'aria-label': `${index + 1} of ${items.length}`,
            })}
          </Fragment>
        ))}
      </div>
    </section>
  )
}

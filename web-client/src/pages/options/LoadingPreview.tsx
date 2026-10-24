import { useState, type ComponentType } from 'react'
import { Button } from '../../components/Button'
import { DetailList } from '../../components/DetailList'
import type { Option } from './catalog'
import { AppChrome, type LoadingViewProps } from './loadingViews'

// Where a preview run has got to. loading: the option is up. leaving: the
// page is ready and the option fades out. gone: only the page shows.
type Phase = 'loading' | 'leaving' | 'gone'

// What a preview frame shows once the option has gone: the app's header
// and the start of a page.
function PageUnder() {
  return (
    <div className="opt-screen opt-screen--frame">
      <AppChrome />
      <div className="opt-page-under">
        <p className="opt-page-under__title">Keep score, run tournaments and follow your club’s results.</p>
        <p className="opt-status">The page is ready.</p>
      </div>
    </div>
  )
}

function Frame({
  label,
  phone = false,
  View,
  phase,
  onLeft,
}: {
  label: string
  phone?: boolean
  View: ComponentType<LoadingViewProps>
  phase: Phase
  onLeft: () => void
}) {
  return (
    <figure className="opt-frame-wrap">
      <figcaption className="doc-cap">{label}</figcaption>
      <div className={phone ? 'opt-frame opt-frame--phone' : 'opt-frame'}>
        <PageUnder />
        {phase !== 'gone' && <View leaving={phase === 'leaving'} onLeft={onLeft} />}
      </div>
    </figure>
  )
}

// A loading-screen option in a desktop frame and a phone frame. Show again
// remounts it, so its entrance plays once more. Finish loading plays the
// fade-out the real page would start once it's ready.
export function LoadingPreview({
  option,
  View,
}: {
  option: Option
  View: ComponentType<LoadingViewProps>
}) {
  const [run, setRun] = useState(0)
  const [phase, setPhase] = useState<Phase>('loading')
  const showAgain = () => {
    setRun(run + 1)
    setPhase('loading')
  }
  const onLeft = () => setPhase('gone')
  return (
    <>
      <header className="doc-head">
        <h1>{option.title}</h1>
      </header>
      <div className="opt-preview-actions">
        <Button variant="secondary" onClick={showAgain}>
          Show again
        </Button>
        <Button
          variant="primary"
          disabled={phase !== 'loading'}
          onClick={() => setPhase('leaving')}
        >
          Finish loading
        </Button>
      </div>
      <div className="opt-frames" key={run}>
        <Frame label="Desktop" View={View} phase={phase} onLeft={onLeft} />
        <Frame label="Phone" phone View={View} phase={phase} onLeft={onLeft} />
      </div>
      <section className="opt-contract" aria-label="What stays the same">
        <h2 className="fm-section-title">What stays the same</h2>
        <DetailList
          details={[
            { term: 'Shows after', value: '300ms', numeric: true },
            { term: 'Stays up for at least', value: '900ms', numeric: true },
            { term: 'Fade-out', value: '240ms', numeric: true },
            { term: 'Accessible name', value: 'Loading FortyMM' },
          ]}
        />
      </section>
    </>
  )
}

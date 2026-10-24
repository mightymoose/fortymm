import { PageHeader } from '../components/PageHeader'
import { PageIntro } from '../components/PageIntro'
import { DataDisplaySection } from './designSystem/DataDisplaySection'
import { FeedbackSection } from './designSystem/FeedbackSection'
import { FormsSection } from './designSystem/FormsSection'
import { NavigationSection } from './designSystem/NavigationSection'
import { OverlaysSection } from './designSystem/OverlaysSection'

export function DesignSystem() {
  return (
    <>
      <PageHeader title="Design System" subtitle="FortyMM · tokens · components" />
      <PageIntro>
        Every FortyMM component, styled with the design system's tokens. Use
        this page as your visual reference: if a component looks different
        here, it looks different in the app.
      </PageIntro>
      <FormsSection />
      <DataDisplaySection />
      <NavigationSection />
      <OverlaysSection />
      <FeedbackSection />
    </>
  )
}

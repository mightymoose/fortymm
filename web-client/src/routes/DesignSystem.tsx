import { PageHeader } from '../components/PageHeader'
import { PageIntro } from '../components/PageIntro'
import { Section } from '../components/Section'

export function DesignSystem() {
  return (
    <>
      <PageHeader title="Design System" subtitle="FortyMM · tokens · components" />
      <PageIntro>
        Every FortyMM component, styled with the design system's tokens. Use
        this page as your visual reference: if a component looks different
        here, it looks different in the app.
      </PageIntro>
      <Section
        id="forms"
        title="Forms & Input"
        lead={
          <>
            Buttons, inputs, selectors. The interactive surface of every form.
            Hero color (<code>--ball-500</code>) is reserved for the single
            primary action per screen.
          </>
        }
      />
    </>
  )
}

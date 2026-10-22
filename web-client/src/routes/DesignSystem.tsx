import { Button } from '../components/Button'
import { ComponentCard } from '../components/ComponentCard'
import { Field, FieldHelp, Label } from '../components/Field'
import { Input } from '../components/Input'
import { OtpInput } from '../components/OtpInput'
import { PageHeader } from '../components/PageHeader'
import { PageIntro } from '../components/PageIntro'
import { Section } from '../components/Section'
import { Textarea } from '../components/Textarea'

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
      >
        <ComponentCard title="Button" tag="7 variants · 4 sizes">
          <div className="col">
            <div className="row">
              <Button>Log a match</Button>
              <Button variant="secondary">Save draft</Button>
              <Button variant="outline">Cancel</Button>
              <Button variant="ghost">Skip</Button>
              <Button variant="destructive">Forfeit match</Button>
              <Button variant="link">Read manifesto</Button>
              <Button disabled>Disabled</Button>
            </div>
            <div className="row">
              <Button size="sm">Small</Button>
              <Button>Default</Button>
              <Button size="lg">Large</Button>
              <Button size="icon" aria-label="Add">
                +
              </Button>
            </div>
          </div>
        </ComponentCard>
        <ComponentCard title="Input · Label · Form Field" tag="composite">
          <div className="grid-2">
            <Field>
              <Label>Player tag</Label>
              <Input placeholder="@yourname" defaultValue="@nguyen.t" />
              <FieldHelp>Visible to opponents in match invites.</FieldHelp>
            </Field>
            <Field required invalid>
              <Label>Email</Label>
              <Input defaultValue="not-an-email" />
              <FieldHelp>Enter a valid email address.</FieldHelp>
            </Field>
            <Field disabled>
              <Label>Disabled</Label>
              <Input defaultValue="Locked field" />
            </Field>
            <Field>
              <Label>Search</Label>
              <Input placeholder="Search clubs, players, tournaments…" />
            </Field>
          </div>
        </ComponentCard>
        <ComponentCard title="Textarea" tag="resizable">
          <Field>
            <Label>Match notes</Label>
            <Textarea
              placeholder="Add context — venue, conditions, anything memorable."
              defaultValue="Played in the back hall. Andrew's forehand was on fire today — three straight games to 11."
            />
          </Field>
        </ComponentCard>
        <ComponentCard title="Input OTP" tag="6-digit">
          {/* The reference shows no label, so this one is only for screen
              readers. The fourth cell is shown active, as in the reference,
              until the input is focused. */}
          <Field>
            <Label className="visually-hidden">Verification code</Label>
            <OtpInput defaultValue="40MM" activeIndex={3} />
          </Field>
        </ComponentCard>
      </Section>
    </>
  )
}

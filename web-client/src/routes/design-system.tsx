import { createFileRoute } from '@tanstack/react-router'
import { zodResolver } from '@hookform/resolvers/zod'
import { format } from 'date-fns'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import {
  Calendar as CalendarIcon,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  CircleCheck,
  Info,
  RefreshCw,
  Search,
  TriangleAlert,
  XCircle,
} from 'lucide-react'

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AspectRatio } from '@/components/ui/aspect-ratio'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem,
} from '@/components/ui/carousel'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from '@/components/ui/input-otp'
import { Label } from '@/components/ui/label'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
} from '@/components/ui/pagination'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Calendar } from '@/components/ui/calendar'
import { pageTitle } from '@/lib/page-title'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/design-system')({
  head: () => ({
    meta: [{ title: pageTitle('Design system') }],
  }),
  component: DesignSystemPage,
})

/** Inline SVG avatar for the Avatar IMAGE-variant demo (#263). A data URI keeps
 * the showcase self-contained — no network fetch, so it renders identically
 * offline and in the e2e run instead of falling back to initials. */
const DEMO_AVATAR_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%233a4a6e'/%3E%3Ccircle cx='32' cy='25' r='13' fill='%23e9edf5'/%3E%3Crect x='11' y='42' width='42' height='24' rx='12' fill='%23e9edf5'/%3E%3C/svg%3E"

/** Selected day for the Date Picker showcase (matches the trigger label). */
const SHOWCASE_DAY = new Date(2026, 3, 12)
const formatWeekdayNameShort = (date: Date) => format(date, 'EEEEE')
const CALENDAR_FORMATTERS = { formatWeekdayName: formatWeekdayNameShort }
const noop = () => {}

/** Shared slot style for the Input OTP showcase; index 2 carries its own
 * active/focused variant. */
const OTP_SLOT_CLASS =
  'size-11 rounded-md border border-[color:var(--border-subtle)] text-base first:rounded-l-md last:rounded-r-md first:border-l'

const TOGGLE_GROUP_ACCENT_CLASS =
  'border-transparent data-[state=on]:bg-[color:var(--ball-500)]/15 data-[state=on]:text-[color:var(--ball-500)]'

const TABLE_HEAD_CLASS = 'uppercase text-xs tracking-[0.08em] text-[color:var(--fg-3)]'

function Section({
  id,
  title,
  lead,
  children,
}: {
  id: string
  title: string
  lead: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className="mb-20">
      <h2 className="font-display mb-2 text-4xl text-foreground">{title}</h2>
      <p className="mb-8 max-w-2xl text-sm text-[color:var(--fg-3)]">{lead}</p>
      <div className="flex flex-col gap-6">{children}</div>
    </section>
  )
}

function Showcase({
  title,
  tag,
  children,
}: {
  title: string
  tag: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-[color:var(--border-subtle)] bg-card p-8" aria-label={title}>
      <div className="mb-6 flex items-baseline justify-between gap-4">
        <h3 className="text-lg font-semibold text-foreground">{title}</h3>
        <span className="ds-overline">{tag}</span>
      </div>
      {children}
    </section>
  )
}

function DesignSystemPage() {
  return (
    <TooltipProvider>
      <div className="dark fortymm-theme min-h-screen">
        <div className="mx-auto max-w-[1200px] px-4 pt-16 pb-32 sm:px-12">
          <header className="mb-14 flex items-baseline gap-4 border-b border-[color:var(--border-subtle)] pb-6">
            <h1 className="font-display m-0 text-[56px] leading-none">
              SHADCN/UI · FORTYMM
            </h1>
            <span className="ds-sub">
              shadcn components · branded · static demo
            </span>
          </header>

          <p className="mt-[-16px] mb-14 max-w-[680px] text-sm leading-relaxed text-[color:var(--fg-3)]">
            Every shadcn/ui component, restyled in the FortyMM dark-arena
            palette. Hero color (
            <code className="rounded border border-[color:var(--border-subtle)] bg-[color:var(--bg-panel)] px-1.5 py-0.5 font-mono text-[color:var(--fg-2)]">
              --ball-500
            </code>
            ) is reserved for the single primary action per screen.
          </p>

          <FormsSection />
          <DataDisplaySection />
          <NavigationSection />
          <OverlaysSection />
          <FeedbackSection />
          <LayoutSection />

          <footer className="flex items-center gap-2 border-t border-[color:var(--border-subtle)] pt-8 font-mono text-xs tracking-[0.1em] text-[color:var(--fg-3)] uppercase">
            <span className="ball-dot" aria-hidden />
            <span>FortyMM · shadcn/ui · v1</span>
          </footer>
        </div>
      </div>
    </TooltipProvider>
  )
}

const playerProfileSchema = z.object({
  playerTag: z
    .string()
    .min(2, { message: 'Player tag must be at least 2 characters.' })
    .max(20, { message: 'Player tag must be 20 characters or fewer.' })
    .regex(/^@[a-zA-Z0-9._-]+$/, {
      message: 'Start with @ and use letters, numbers, dots, dashes, or underscores.',
    }),
  email: z.string().email({ message: 'Enter a valid email address.' }),
  matchNotes: z
    .string()
    .max(280, { message: 'Keep notes under 280 characters.' })
    .optional(),
})

type PlayerProfileValues = z.infer<typeof playerProfileSchema>

function PlayerProfileForm() {
  const form = useForm<PlayerProfileValues>({
    resolver: zodResolver(playerProfileSchema),
    defaultValues: {
      playerTag: '@nguyen.t',
      email: 'not-an-email',
      matchNotes: '',
    },
    mode: 'onTouched',
  })

  const onSubmit = form.handleSubmit((values) => {
    console.log('player profile submitted', values)
  })

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4 md:grid-cols-2" noValidate>
        <FormField
          control={form.control}
          name="playerTag"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Player tag</FormLabel>
              <FormControl>
                <Input placeholder="@yourname" {...field} />
              </FormControl>
              <FormDescription>
                Visible to opponents in match invites.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Email <span className="text-[color:var(--loss)]">*</span>
              </FormLabel>
              <FormControl>
                <Input type="email" placeholder="you@example.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="matchNotes"
          render={({ field }) => (
            <FormItem className="md:col-span-2">
              <FormLabel>Match notes</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Add context — venue, conditions, anything memorable."
                  className="min-h-24"
                  {...field}
                />
              </FormControl>
              <FormDescription>Optional · up to 280 characters.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="md:col-span-2 flex items-center gap-3">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            Save profile
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => form.reset()}
            disabled={!form.formState.isDirty}
          >
            Reset
          </Button>
        </div>
      </form>
    </Form>
  )
}

function FormsSection() {
  return (
    <Section
      id="forms"
      title="Forms & Input"
      lead="Buttons, inputs, selectors. The interactive surface of every form. Hero color is reserved for the single primary action per screen."
    >
      <Showcase title="Button" tag="7 variants · 4 sizes">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button>Log a match</Button>
            <Button variant="secondary">Save draft</Button>
            <Button variant="outline">Cancel</Button>
            <Button variant="ghost">Skip</Button>
            <Button variant="destructive">Forfeit match</Button>
            <Button variant="link">Read manifesto</Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Small</Button>
            <Button>Default</Button>
            <Button size="lg">Large</Button>
            <Button size="icon" aria-label="Add">
              +
            </Button>
          </div>
        </div>
      </Showcase>

      <Showcase title="Input · Label · Form Field" tag="composite">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="mb-[18px]">
            <Label htmlFor="ds-player-tag" className="mb-1.5 block text-sm">
              Player tag
            </Label>
            <Input
              id="ds-player-tag"
              placeholder="@yourname"
              defaultValue="@nguyen.t"
            />
            <p className="mt-1.5 text-xs leading-normal text-[color:var(--fg-3)]">
              Visible to opponents in match invites.
            </p>
          </div>
          <div className="mb-[18px]">
            <Label htmlFor="ds-email" className="mb-1.5 block text-sm">
              Email <span className="text-[color:var(--loss)]">*</span>
            </Label>
            <Input id="ds-email" aria-invalid defaultValue="not-an-email" />
            <p className="mt-1.5 text-xs leading-normal text-[color:var(--loss)]">
              Enter a valid email address.
            </p>
          </div>
          <div className="mb-[18px]">
            <Label htmlFor="ds-locked" className="mb-1.5 block text-sm">
              Disabled
            </Label>
            <Input id="ds-locked" disabled defaultValue="Locked field" />
          </div>
          <div className="mb-[18px]">
            <Label htmlFor="ds-search" className="mb-1.5 block text-sm">
              Search
            </Label>
            <Input
              id="ds-search"
              placeholder="Search clubs, players, tournaments…"
            />
          </div>
        </div>
      </Showcase>

      <Showcase title="Form · Validation" tag="zod + react-hook-form">
        <PlayerProfileForm />
      </Showcase>

      <Showcase title="Textarea" tag="resizable">
        <Label className="mb-1.5 block text-sm">Match notes</Label>
        <Textarea
          placeholder="Add context — venue, conditions, anything memorable."
          defaultValue="Played in the back hall. Andrew's forehand was on fire today — three straight games to 11."
          className="min-h-24"
        />
      </Showcase>

      <Showcase title="Input OTP" tag="6-digit">
        <InputOTP maxLength={6} value="42" onChange={noop}>
          <InputOTPGroup className="gap-2">
            <InputOTPSlot index={0} className={OTP_SLOT_CLASS} />
            <InputOTPSlot index={1} className={OTP_SLOT_CLASS} />
            <InputOTPSlot
              index={2}
              className={cn(
                OTP_SLOT_CLASS,
                'relative z-10 border-[color:var(--ball-500)] ring-3 ring-[color:var(--ball-500)]/50',
              )}
            />
          </InputOTPGroup>
          <InputOTPSeparator />
          <InputOTPGroup className="gap-2">
            <InputOTPSlot index={3} className={OTP_SLOT_CLASS} />
            <InputOTPSlot index={4} className={OTP_SLOT_CLASS} />
            <InputOTPSlot index={5} className={OTP_SLOT_CLASS} />
          </InputOTPGroup>
        </InputOTP>
      </Showcase>

      <Showcase title="Checkbox" tag="3 states">
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2.5 text-sm">
            <Checkbox defaultChecked />
            <span>I agree to the rules of fair play</span>
          </label>
          <label className="flex items-center gap-2.5 text-sm">
            <Checkbox />
            <span>Email me match invites</span>
          </label>
          <label className="flex items-center gap-2.5 text-sm opacity-50">
            <Checkbox disabled />
            <span>Disabled option</span>
          </label>
        </div>
      </Showcase>

      <Showcase title="Radio Group" tag="single-select">
        <RadioGroup defaultValue="bo5" className="gap-2.5">
          <label className="flex items-center gap-2.5 text-sm">
            <RadioGroupItem value="bo5" />
            <span>Singles · best of 5</span>
          </label>
          <label className="flex items-center gap-2.5 text-sm">
            <RadioGroupItem value="bo7" />
            <span>Singles · best of 7</span>
          </label>
          <label className="flex items-center gap-2.5 text-sm">
            <RadioGroupItem value="dbo5" />
            <span>Doubles · best of 5</span>
          </label>
        </RadioGroup>
      </Showcase>

      <Showcase title="Switch" tag="on/off">
        <div className="flex max-w-[320px] flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-sm">Public profile</span>
            <Switch defaultChecked />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Notify me of nearby matches</span>
            <Switch />
          </div>
        </div>
      </Showcase>

      <Showcase title="Slider" tag="single + range">
        <div className="flex max-w-[480px] flex-col gap-6">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm text-[color:var(--fg-3)]">Skill level</span>
              <span className="font-mono text-sm text-[color:var(--ball-500)]">
                1620
              </span>
            </div>
            <Slider defaultValue={[55]} max={100} step={1} />
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm text-[color:var(--fg-3)]">Rating range</span>
              <span className="font-mono text-sm text-[color:var(--ball-500)]">
                1400 – 1800
              </span>
            </div>
            <Slider defaultValue={[30, 70]} max={100} step={1} />
          </div>
        </div>
      </Showcase>

      <Showcase title="Select" tag="compact">
        <div className="flex flex-wrap items-center gap-3">
          <Select defaultValue="singles">
            <SelectTrigger size="sm" className="w-full max-w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="singles">Singles</SelectItem>
              <SelectItem value="doubles">Doubles</SelectItem>
              <SelectItem value="mixed">Mixed</SelectItem>
            </SelectContent>
          </Select>
          <Select defaultValue="bo5">
            <SelectTrigger size="sm" className="w-full max-w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bo5">Best of 5 games</SelectItem>
              <SelectItem value="bo7">Best of 7 games</SelectItem>
              <SelectItem value="bo3">Best of 3 games</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Showcase>

      <Showcase title="Combobox · Command" tag="searchable select · open">
        <Command className="w-full max-w-[340px] border border-[color:var(--border-subtle)]">
          <CommandInput placeholder="Find a player…" />
          <CommandList>
            <CommandEmpty>No player found.</CommandEmpty>
            <CommandGroup>
              <CommandItem className="justify-between">
                <span>Nguyen, Tien</span>
                <span className="font-mono text-[color:var(--fg-3)]">1620</span>
              </CommandItem>
              <CommandItem className="justify-between">
                <span>Nguyen, Mai</span>
                <span className="font-mono text-[color:var(--fg-3)]">1455</span>
              </CommandItem>
              <CommandItem className="justify-between">
                <span>Nguyen, Phuc</span>
                <span className="font-mono text-[color:var(--fg-3)]">1380</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </Showcase>

      <Showcase title="Date Picker" tag="calendar in popover">
        <div className="flex flex-wrap items-start gap-6">
          <div>
            <Label className="mb-1.5 block text-sm">Match date</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full max-w-[220px] justify-start gap-2">
                  <CalendarIcon className="size-4" />
                  April 12, 2026
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0">
                <Calendar
                  mode="single"
                  selected={SHOWCASE_DAY}
                  defaultMonth={SHOWCASE_DAY}
                  onSelect={noop}
                  formatters={CALENDAR_FORMATTERS}
                />
              </PopoverContent>
            </Popover>
          </div>
          <Calendar
            mode="single"
            selected={SHOWCASE_DAY}
            defaultMonth={SHOWCASE_DAY}
            onSelect={noop}
            formatters={CALENDAR_FORMATTERS}
            className="rounded-lg border border-[color:var(--border-subtle)]"
          />
        </div>
      </Showcase>

      <Showcase title="Toggle · Toggle Group" tag="single + multi">
        <div className="flex flex-wrap items-center gap-3">
          <Toggle defaultPressed aria-label="Bold">
            B
          </Toggle>
          <Toggle aria-label="Italic">I</Toggle>
          <Separator orientation="vertical" className="h-8" />
          <ToggleGroup
            type="single"
            defaultValue="singles"
            variant="outline"
            className="gap-0 rounded-lg border border-[color:var(--border-subtle)] p-0.5"
          >
            <ToggleGroupItem value="singles" className={TOGGLE_GROUP_ACCENT_CLASS}>
              Singles
            </ToggleGroupItem>
            <ToggleGroupItem value="doubles" className={TOGGLE_GROUP_ACCENT_CLASS}>
              Doubles
            </ToggleGroupItem>
            <ToggleGroupItem value="mixed" className={TOGGLE_GROUP_ACCENT_CLASS}>
              Mixed
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </Showcase>
    </Section>
  )
}

function DataDisplaySection() {
  return (
    <Section
      id="display"
      title="Data Display"
      lead="Cards, tables, badges, avatars. The product is ratings and rankings — these components are where the numbers live."
    >
      <Showcase title="Card" tag="container">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>April Spring Open</CardTitle>
              <CardDescription>Hosted by Brooklyn TT Club</CardDescription>
            </CardHeader>
            <CardContent className="text-sm leading-relaxed text-[color:var(--fg-2)]">
              32 players, single-elimination, 4 courts. Scheduling auto-generated by
              SMT solver.
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm">Register</Button>
              <Button size="sm" variant="outline">
                View draw
              </Button>
            </CardFooter>
          </Card>
          <Card
            className="ring-2 ring-[color:var(--ball-500)]"
            style={{ boxShadow: 'var(--shadow-glow)' }}
          >
            <CardHeader>
              <CardTitle className="text-[color:var(--ball-500)]">
                ★ Featured
              </CardTitle>
              <CardDescription>National Championships qualifier</CardDescription>
            </CardHeader>
            <CardContent className="text-sm leading-relaxed text-[color:var(--fg-2)]">
              Top 8 advance to the regional bracket. Limited to USATT members.
            </CardContent>
            <CardFooter>
              <Button size="sm">Apply</Button>
            </CardFooter>
          </Card>
        </div>
      </Showcase>

      <Showcase title="Badge" tag="5 variants">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Seed 1</Badge>
          <Badge variant="secondary">Doubles</Badge>
          <Badge variant="outline">Pending</Badge>
          <Badge variant="destructive">Disqualified</Badge>
          <Badge
            variant="outline"
            className="border-[color:var(--serve-500)] bg-[color:var(--bg-live-soft)] text-[color:var(--serve-500)]"
          >
            <span className="ball-dot ball-dot--live" aria-hidden />
            Live · Court 3
          </Badge>
        </div>
      </Showcase>

      <Showcase title="Avatar" tag="image · initials · stack">
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-3">
            <Avatar className="size-14 text-base">
              <AvatarImage src={DEMO_AVATAR_SRC} alt="" />
              <AvatarFallback>IMG</AvatarFallback>
            </Avatar>
          </div>
          <div className="flex items-center gap-3">
            <Avatar className="size-7 text-xs">
              <AvatarFallback>TN</AvatarFallback>
            </Avatar>
            <Avatar>
              <AvatarFallback>DO</AvatarFallback>
            </Avatar>
            <Avatar className="size-14 text-base">
              <AvatarFallback className="bg-[color:var(--ball-500)] text-[color:var(--ink-950)]">
                MK
              </AvatarFallback>
            </Avatar>
          </div>
          <div className="flex">
            <Avatar className="-ml-2 ring-2 ring-[color:var(--bg-card)] first:ml-0">
              <AvatarFallback className="bg-[#3a4a6e]">TN</AvatarFallback>
            </Avatar>
            <Avatar className="-ml-2 ring-2 ring-[color:var(--bg-card)]">
              <AvatarFallback className="bg-[#6e3a4a]">DO</AvatarFallback>
            </Avatar>
            <Avatar className="-ml-2 ring-2 ring-[color:var(--bg-card)]">
              <AvatarFallback className="bg-[#4a6e3a]">MK</AvatarFallback>
            </Avatar>
            <Avatar className="-ml-2 ring-2 ring-[color:var(--bg-card)]">
              <AvatarFallback className="bg-[color:var(--ink-700)] text-xs">
                +12
              </AvatarFallback>
            </Avatar>
          </div>
        </div>
      </Showcase>

      <Showcase title="Table · Data Table" tag="standings">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={TABLE_HEAD_CLASS}>Player</TableHead>
              <TableHead className={TABLE_HEAD_CLASS}>Club</TableHead>
              <TableHead className={cn(TABLE_HEAD_CLASS, 'text-right')}>Rating</TableHead>
              <TableHead className={cn(TABLE_HEAD_CLASS, 'text-right')}>W–L</TableHead>
              <TableHead className={cn(TABLE_HEAD_CLASS, 'text-right')}>Δ</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>
                <div className="flex items-center gap-2.5">
                  <Avatar className="size-7 text-xs">
                    <AvatarFallback className="bg-[#3a4a6e]">TN</AvatarFallback>
                  </Avatar>
                  Nguyen, Tien
                </div>
              </TableCell>
              <TableCell>Brooklyn TT</TableCell>
              <TableCell className="text-right font-mono">1620</TableCell>
              <TableCell className="text-right font-mono">14–3</TableCell>
              <TableCell className="text-right font-mono text-[color:var(--serve-500)]">
                +18
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>
                <div className="flex items-center gap-2.5">
                  <Avatar className="size-7 text-xs">
                    <AvatarFallback className="bg-[#6e3a4a]">DO</AvatarFallback>
                  </Avatar>
                  Okafor, Daniel
                </div>
              </TableCell>
              <TableCell>NYC Open Hall</TableCell>
              <TableCell className="text-right font-mono">1582</TableCell>
              <TableCell className="text-right font-mono">11–4</TableCell>
              <TableCell className="text-right font-mono text-[color:var(--serve-500)]">
                +12
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>
                <div className="flex items-center gap-2.5">
                  <Avatar className="size-7 text-xs">
                    <AvatarFallback className="bg-[#4a6e3a]">MK</AvatarFallback>
                  </Avatar>
                  Kowalski, Marta
                </div>
              </TableCell>
              <TableCell>Brooklyn TT</TableCell>
              <TableCell className="text-right font-mono">1505</TableCell>
              <TableCell className="text-right font-mono">8–6</TableCell>
              <TableCell className="text-right font-mono text-[color:var(--loss)]">
                −4
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Showcase>

      <Showcase title="Progress" tag="determinate">
        <div className="flex max-w-[420px] flex-col gap-4">
          <div>
            <div className="mb-1.5 flex justify-between text-sm">
              <span>Round 1 of 5</span>
              <span className="font-mono text-[color:var(--fg-3)]">12 / 16</span>
            </div>
            <Progress value={75} />
          </div>
          <div>
            <div className="mb-1.5 flex justify-between text-sm">
              <span>Group B</span>
              <span className="font-mono text-[color:var(--fg-3)]">25%</span>
            </div>
            <Progress value={25} />
          </div>
        </div>
      </Showcase>

      <Showcase title="Skeleton" tag="loading state">
        <div className="flex items-center gap-4">
          <Skeleton className="size-12 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
      </Showcase>

      <Showcase title="Aspect Ratio" tag="16:9 · 1:1">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <AspectRatio
            ratio={16 / 9}
            className="flex items-center justify-center rounded-lg bg-gradient-to-br from-[color:var(--ink-700)] to-[color:var(--ink-800)]"
          >
            <span className="font-mono text-xs tracking-[0.1em] text-[color:var(--fg-3)]">
              16 : 9
            </span>
          </AspectRatio>
          <AspectRatio
            ratio={1}
            className="flex items-center justify-center rounded-lg bg-gradient-to-br from-[color:var(--ink-700)] to-[color:var(--ink-800)]"
          >
            <span className="font-mono text-xs tracking-[0.1em] text-[color:var(--fg-3)]">
              1 : 1
            </span>
          </AspectRatio>
        </div>
      </Showcase>
    </Section>
  )
}

function NavigationSection() {
  return (
    <Section
      id="nav"
      title="Navigation"
      lead="Tabs, breadcrumbs, pagination, menus. Wayfinding inside the app."
    >
      <Showcase title="Tabs" tag="boxed + underlined">
        <div className="flex flex-col gap-8">
          <div>
            <span className="ds-overline">BOXED</span>
            <Tabs defaultValue="overview" className="mt-3">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="schedule">Schedule</TabsTrigger>
                <TabsTrigger value="standings">Standings</TabsTrigger>
                <TabsTrigger value="players">Players</TabsTrigger>
              </TabsList>
              <TabsContent
                value="overview"
                className="pt-5 text-sm text-[color:var(--fg-2)]"
              >
                Tournament overview — 32 players, 4 courts, finals projected for
                6:45pm.
              </TabsContent>
              <TabsContent
                value="schedule"
                className="pt-5 text-sm text-[color:var(--fg-2)]"
              >
                Schedule auto-generated by the SMT solver. Re-run after any draw
                change.
              </TabsContent>
              <TabsContent
                value="standings"
                className="pt-5 text-sm text-[color:var(--fg-2)]"
              >
                Live standings. Sorted by W–L, then rating delta.
              </TabsContent>
              <TabsContent
                value="players"
                className="pt-5 text-sm text-[color:var(--fg-2)]"
              >
                32 registered. 28 checked in. 4 pending.
              </TabsContent>
            </Tabs>
          </div>
          <div>
            <span className="ds-overline">UNDERLINED</span>
            <Tabs defaultValue="overview" className="mt-3">
              <TabsList
                variant="line"
                className="[&_[data-slot=tabs-trigger]]:after:bg-[color:var(--ball-500)]"
              >
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="schedule">Schedule</TabsTrigger>
                <TabsTrigger value="standings">Standings</TabsTrigger>
                <TabsTrigger value="players">Players</TabsTrigger>
              </TabsList>
              <TabsContent
                value="overview"
                className="pt-5 text-sm text-[color:var(--fg-2)]"
              >
                Tournament overview — 32 players, 4 courts, finals projected for
                6:45pm.
              </TabsContent>
              <TabsContent
                value="schedule"
                className="pt-5 text-sm text-[color:var(--fg-2)]"
              >
                Schedule auto-generated by the SMT solver. Re-run after any draw
                change.
              </TabsContent>
              <TabsContent
                value="standings"
                className="pt-5 text-sm text-[color:var(--fg-2)]"
              >
                Live standings. Sorted by W–L, then rating delta.
              </TabsContent>
              <TabsContent
                value="players"
                className="pt-5 text-sm text-[color:var(--fg-2)]"
              >
                32 registered. 28 checked in. 4 pending.
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </Showcase>

      <Showcase title="Accordion" tag="collapsible FAQ">
        <Accordion type="single" defaultValue="smt" collapsible className="max-w-[600px]">
          <AccordionItem value="smt">
            <AccordionTrigger>How does the SMT scheduler work?</AccordionTrigger>
            <AccordionContent>
              It treats every match as a constraint and solves for an assignment
              that minimizes back-to-backs, balances court usage, and respects
              player breaks.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="free">
            <AccordionTrigger>Is FortyMM really free?</AccordionTrigger>
            <AccordionContent>
              Yes. No ads, no premium tier, no upsells. Made by players, for
              players.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="ratings">
            <AccordionTrigger>How do ratings update?</AccordionTrigger>
            <AccordionContent>
              We use a Glicko-2 system with a 0.06 volatility cap. Updates happen
              after every match.
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Showcase>

      <Showcase title="Breadcrumb" tag="trail">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#">Tournaments</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#">April Spring Open</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Round 3</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Showcase>

      <Showcase title="Pagination" tag="paged tables">
        <Pagination className="justify-start">
          <PaginationContent>
            <PaginationItem>
              <PaginationLink href="#" aria-label="Go to previous page">
                <ChevronLeft className="size-4" />
              </PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#" isActive>
                1
              </PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#">2</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#">3</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationEllipsis />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#">12</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#" aria-label="Go to next page">
                <ChevronRight className="size-4" />
              </PaginationLink>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </Showcase>

      <Showcase title="Navigation Menu" tag="mega-dropdown">
        {/* Static inline facsimile of the open mega-dropdown — the real
            NavigationMenuContent renders in an absolutely-positioned viewport
            that escapes this card and collides with the Menubar below, so we
            show the Product panel open inline (#251). */}
        <div>
          <div className="flex gap-1">
            <div className="inline-flex h-9 items-center gap-1 rounded-md bg-[color:var(--bg-hover)] px-4 text-sm font-medium">
              Product <ChevronDown className="size-3.5 rotate-180" />
            </div>
            <div className="inline-flex h-9 items-center gap-1 rounded-md px-4 text-sm font-medium text-[color:var(--fg-2)]">
              Tournaments <ChevronDown className="size-3.5" />
            </div>
          </div>
          <div
            className="mt-2 w-full max-w-[480px] rounded-md border border-[color:var(--border-subtle)] bg-popover text-popover-foreground"
            style={{ boxShadow: 'var(--shadow-lg)' }}
          >
            <ul className="grid w-full grid-cols-1 gap-2 p-3 sm:grid-cols-2">
              <li>
                <a className="block rounded-md p-2.5 hover:bg-[color:var(--bg-hover)]">
                  <p className="text-sm font-medium">Match recorder</p>
                  <p className="text-xs text-[color:var(--fg-3)]">
                    Track scores in real time, no internet needed.
                  </p>
                </a>
              </li>
              <li>
                <a className="block rounded-md p-2.5 hover:bg-[color:var(--bg-hover)]">
                  <p className="text-sm font-medium">Tournament admin</p>
                  <p className="text-xs text-[color:var(--fg-3)]">
                    SMT-solved draws and live scoring.
                  </p>
                </a>
              </li>
              <li>
                <a className="block rounded-md p-2.5 hover:bg-[color:var(--bg-hover)]">
                  <p className="text-sm font-medium">Spectator brackets</p>
                  <p className="text-xs text-[color:var(--fg-3)]">
                    Shareable, public, branded.
                  </p>
                </a>
              </li>
              <li>
                <a className="block rounded-md p-2.5 hover:bg-[color:var(--bg-hover)]">
                  <p className="text-sm font-medium">Club tools</p>
                  <p className="text-xs text-[color:var(--fg-3)]">
                    Member rosters, ladder leagues.
                  </p>
                </a>
              </li>
            </ul>
          </div>
        </div>
      </Showcase>

      <Showcase title="Menubar" tag="desktop app">
        {/* Static inline facsimile with the File menu open and active — the real
            MenubarContent portals and floats, colliding with the Navigation Menu
            card above, so the open state is rendered inline (#271). */}
        <div className="w-full max-w-fit">
          <div className="flex flex-wrap items-center gap-0.5 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-1">
            <div className="rounded-sm bg-[color:var(--bg-hover)] px-3 py-1 text-sm font-medium">
              File
            </div>
            <div className="rounded-sm px-3 py-1 text-sm font-medium text-[color:var(--fg-2)]">
              Edit
            </div>
            <div className="rounded-sm px-3 py-1 text-sm font-medium text-[color:var(--fg-2)]">
              View
            </div>
            <div className="rounded-sm px-3 py-1 text-sm font-medium text-[color:var(--fg-2)]">
              Tournament
            </div>
            <div className="rounded-sm px-3 py-1 text-sm font-medium text-[color:var(--fg-2)]">
              Help
            </div>
          </div>
          <div
            className="mt-1 w-full max-w-[200px] rounded-md border border-[color:var(--border-subtle)] bg-popover p-1 text-popover-foreground"
            style={{ boxShadow: 'var(--shadow-lg)' }}
          >
            <div className="rounded-sm px-2 py-1.5 text-sm hover:bg-[color:var(--bg-hover)]">
              New tournament
            </div>
            <div className="rounded-sm px-2 py-1.5 text-sm hover:bg-[color:var(--bg-hover)]">
              Open…
            </div>
            <div className="rounded-sm px-2 py-1.5 text-sm hover:bg-[color:var(--bg-hover)]">
              Export draw
            </div>
          </div>
        </div>
      </Showcase>
    </Section>
  )
}

function OverlaysSection() {
  return (
    <Section
      id="overlays"
      title="Overlays"
      lead="Dialogs, sheets, popovers, menus. Content that floats above the canvas."
    >
      <Showcase title="Dialog · Alert Dialog" tag="modal · open state">
        <div className="flex flex-wrap gap-3">
          <div
            className="w-full max-w-[420px] rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-6"
            style={{ boxShadow: 'var(--shadow-lg)' }}
          >
            <h3 className="font-semibold">Forfeit this match?</h3>
            <p className="mt-2 text-sm text-[color:var(--fg-3)]">
              Your opponent will be awarded the win and your rating will be
              adjusted accordingly. This can't be undone.
            </p>
            <label className="mt-5 flex items-center gap-2.5 text-sm">
              <Checkbox />
              <span>Send a note to my opponent</span>
            </label>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline">Cancel</Button>
              <Button variant="destructive">Forfeit</Button>
            </div>
          </div>

          <div
            className="w-full max-w-[380px] rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-6"
            style={{ boxShadow: 'var(--shadow-lg)' }}
          >
            <h3 className="flex items-center gap-2.5 font-semibold">
              <TriangleAlert className="size-5 text-[color:var(--warn)]" />
              Delete account
            </h3>
            <p className="mt-2 text-sm text-[color:var(--fg-3)]">
              All match history, ratings, and tournament records will be
              permanently deleted.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline">Keep account</Button>
              <Button variant="destructive">Delete</Button>
            </div>
          </div>
        </div>
      </Showcase>

      <Showcase title="Sheet" tag="side panel · open">
        <div className="flex justify-end">
          <div
            className="w-full max-w-[320px] rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-6"
            style={{ boxShadow: 'var(--shadow-lg)' }}
          >
            <h3 className="text-lg font-semibold">Filters</h3>
            <p className="mt-1 text-sm text-[color:var(--fg-3)]">
              Narrow the player list.
            </p>
            <div className="mt-6 mb-[18px]">
              <Label className="mb-1.5 block text-sm">Club</Label>
              <Select defaultValue="brooklyn">
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="brooklyn">Brooklyn TT</SelectItem>
                  <SelectItem value="nyc">NYC Open Hall</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="mb-[18px]">
              <Label className="mb-1.5 block text-sm">Rating range</Label>
              <Slider defaultValue={[20, 80]} max={100} />
            </div>
            <Button className="w-full">Apply filters</Button>
          </div>
        </div>
      </Showcase>

      <Showcase title="Drawer" tag="mobile bottom sheet">
        <div className="w-full">
          <div
            className="mx-auto w-full max-w-[420px] rounded-t-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-6"
            style={{ boxShadow: 'var(--shadow-lg)' }}
          >
            <div className="mx-auto mb-4 h-1 w-[100px] rounded-full bg-[color:var(--ink-700)]" />
            <h3 className="font-semibold">Quick log</h3>
            <p className="mt-1 text-sm text-[color:var(--fg-3)]">
              Tap to record a finished match.
            </p>
            <div className="mt-6 flex flex-col gap-2">
              <Button>Pick opponent</Button>
              <Button variant="outline">Cancel</Button>
            </div>
          </div>
        </div>
      </Showcase>

      <Showcase title="Popover" tag="contextual content">
        {/* Rendered as a static inline facsimile of the open popover. The real
            PopoverContent portals to <body> and floats anchored to the trigger,
            so forcing it open drifts outside this demo card and over the next
            one; an inline panel keeps the open state contained (#255). */}
        <div className="flex flex-col items-start gap-2">
          <Button variant="outline">Skill rating info</Button>
          <div
            className="w-72 rounded-md border border-[color:var(--border-subtle)] bg-popover p-4 text-popover-foreground"
            style={{ boxShadow: 'var(--shadow-lg)' }}
          >
            <h4 className="mb-1 text-sm font-semibold">Skill rating</h4>
            <p className="text-xs text-[color:var(--fg-3)]">
              Your rating is calculated using a Glicko-2 system with a 0.06
              volatility cap. Updates after every match.
            </p>
          </div>
        </div>
      </Showcase>

      <Showcase title="Tooltip" tag="shown open">
        {/* Force both tooltips open (controlled) so the showcase always renders
            the bubbles, matching the kit reference — a hover-only demo shows a
            bare button + badge with nothing to see (#256). `sideOffset` lifts
            them clear of the trigger. */}
        {/* Stack the two anchors vertically (own row each) AND centre them
            horizontally: side-by-side, Radix centres both top-side bubbles over
            their triggers and they overlap, clipping the first mid-word (#832).
            Centring the triggers keeps each centred bubble inside the card
            rather than spilling off its left edge, and holds at mobile width
            without adding horizontal overflow (#833). */}
        <div className="flex flex-col items-center gap-16 pt-12">
          <Tooltip open>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Refresh">
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={8}>Refresh standings</TooltipContent>
          </Tooltip>
          <Tooltip open>
            <TooltipTrigger asChild>
              <Badge>Seed 1</Badge>
            </TooltipTrigger>
            <TooltipContent sideOffset={8}>
              Highest rated player in this bracket
            </TooltipContent>
          </Tooltip>
        </div>
      </Showcase>

      <Showcase title="Hover Card" tag="player preview">
        {/* Static inline facsimile of the open hover card — the real
            HoverCardContent portals and floats anchored to the trigger, drifting
            outside this card, so we render the open panel inline (#257). */}
        <div className="flex flex-col items-start gap-2">
          <Button variant="link">@nguyen.t</Button>
          <div
            className="w-full max-w-[280px] rounded-md border border-[color:var(--border-subtle)] bg-popover p-4 text-popover-foreground"
            style={{ boxShadow: 'var(--shadow-lg)' }}
          >
            <div className="mb-3 flex items-center gap-3">
              <Avatar className="size-14 text-base">
                <AvatarFallback className="bg-[#3a4a6e]">TN</AvatarFallback>
              </Avatar>
              <div>
                <h4 className="text-sm font-semibold">Tien Nguyen</h4>
                <p className="text-xs text-[color:var(--fg-3)]">
                  Brooklyn TT · Joined 2024
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4 font-mono text-sm">
              <span>
                <span className="text-[color:var(--fg-3)]">Rating</span>{' '}
                <span className="text-[color:var(--ball-500)]">1620</span>
              </span>
              <span>
                <span className="text-[color:var(--fg-3)]">W–L</span> 14–3
              </span>
            </div>
          </div>
        </div>
      </Showcase>

      <Showcase title="Dropdown · Context Menu" tag="right-click + chevron">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Static inline facsimile of the open dropdown menu — the real
              DropdownMenuContent portals and (being modal) would lock page
              scroll while permanently open, so we render the menu inline (#258). */}
          <div className="flex flex-col gap-2">
            <Button variant="outline" className="w-fit">
              Match actions <ChevronDown className="ml-1 size-4" />
            </Button>
            <div
              className="w-full rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-1 text-popover-foreground"
              style={{ boxShadow: 'var(--shadow-lg)' }}
            >
              <div className="px-2 py-1.5 text-xs font-medium text-[color:var(--fg-3)]">
                Match actions
              </div>
              <div className="flex items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-[color:var(--bg-hover)]">
                <span>Rematch</span>
                <span className="font-mono text-xs tracking-widest text-[color:var(--fg-3)]">
                  ⌘R
                </span>
              </div>
              <div className="flex items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-[color:var(--bg-hover)]">
                <span>Share match link</span>
                <span className="font-mono text-xs tracking-widest text-[color:var(--fg-3)]">
                  ⌘⇧S
                </span>
              </div>
              <div className="rounded-sm px-2 py-1.5 text-sm hover:bg-[color:var(--bg-hover)]">
                Edit score
              </div>
              <div className="-mx-1 my-1 h-px bg-[color:var(--border-subtle)]" />
              <div className="rounded-sm px-2 py-1.5 text-sm text-[color:var(--loss)] hover:bg-[color:var(--bg-hover)]">
                Forfeit
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex h-9 items-center justify-center rounded-lg border border-dashed border-[color:var(--border-subtle)] text-sm text-[color:var(--fg-3)]">
              Right-click here
            </div>
            <div
              className="w-full rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-1 text-popover-foreground"
              style={{ boxShadow: 'var(--shadow-lg)' }}
            >
              <div className="flex items-center rounded-sm px-2 py-1.5 text-sm hover:bg-[color:var(--bg-hover)]">
                <Check className="mr-2 size-4" /> Show seeds
              </div>
              <div className="rounded-sm px-2 py-1.5 text-sm hover:bg-[color:var(--bg-hover)]">
                Show ratings
              </div>
              <div className="-mx-1 my-1 h-px bg-[color:var(--border-subtle)]" />
              <div className="rounded-sm px-2 py-1.5 text-sm hover:bg-[color:var(--bg-hover)]">
                Reschedule…
              </div>
              <div className="rounded-sm px-2 py-1.5 text-sm hover:bg-[color:var(--bg-hover)]">
                Print bracket
              </div>
            </div>
          </div>
        </div>
      </Showcase>

      <Showcase title="Command" tag="cmd+k palette">
        <Command className="w-full max-w-[480px] border border-[color:var(--border-subtle)]">
          <CommandInput placeholder="Type a command or search…" />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup heading="Suggestions">
              <CommandItem>
                <Search className="mr-2 size-4" />
                <span>Log a match</span>
                <CommandShortcut>⌘L</CommandShortcut>
              </CommandItem>
              <CommandItem>
                <Search className="mr-2 size-4" />
                <span>Find a player</span>
                <CommandShortcut>⌘P</CommandShortcut>
              </CommandItem>
              <CommandItem>
                <Search className="mr-2 size-4" />
                <span>Open tournament admin</span>
                <CommandShortcut>⌘T</CommandShortcut>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Recent">
              <CommandItem>Nguyen vs. Okafor · 2h ago</CommandItem>
              <CommandItem>April Spring Open · yesterday</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </Showcase>
    </Section>
  )
}

function FeedbackSection() {
  return (
    <Section
      id="feedback"
      title="Feedback"
      lead="Alerts and toasts. The app talking back."
    >
      <Showcase title="Alert" tag="4 variants">
        <div className="flex flex-col gap-3">
          <Alert>
            <Info />
            <AlertTitle>Heads up</AlertTitle>
            <AlertDescription>
              The next round starts in 12 minutes.
            </AlertDescription>
          </Alert>
          <Alert className="border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10">
            <TriangleAlert className="text-[color:var(--warn)]" />
            <AlertTitle className="text-[color:var(--warn)]">
              Late check-in
            </AlertTitle>
            <AlertDescription>
              3 players haven't checked in. They'll be defaulted at 6:00pm.
            </AlertDescription>
          </Alert>
          <Alert variant="destructive">
            <XCircle />
            <AlertTitle>Match voided</AlertTitle>
            <AlertDescription>
              This match was voided by an admin and no longer affects ratings.
            </AlertDescription>
          </Alert>
          <Alert className="border-[color:var(--serve-500)]/40 bg-[color:var(--serve-500)]/10">
            {/* Success alerts read as a check (✓), not an info glyph — matches
                the FortyMM kit reference (#272). */}
            <CircleCheck className="text-[color:var(--serve-500)]" />
            <AlertTitle className="text-[color:var(--serve-500)]">
              Match logged
            </AlertTitle>
            <AlertDescription>
              Your rating moved from 1602 to 1620 (+18).
            </AlertDescription>
          </Alert>
        </div>
      </Showcase>

      <Showcase title="Sonner / Toast" tag="4 variants">
        <div className="flex flex-col gap-5">
          <div className="flex max-w-[420px] flex-col gap-3">
            <ToastCard
              tone="success"
              title="Match logged"
              body="Rating: 1620 (+18)"
            />
            <ToastCard
              tone="error"
              title="Couldn't save"
              body="Try again — your changes are still in the editor."
            />
            <ToastCard
              tone="info"
              title="Reminder"
              body="You're up next on Court 3."
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                toast.success('Match logged', {
                  description: 'Rating: 1620 (+18)',
                })
              }
            >
              Trigger success
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                toast.error("Couldn't save", {
                  description:
                    'Try again — your changes are still in the editor.',
                })
              }
            >
              Trigger error
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                toast.info('Reminder', {
                  description: "You're up next on Court 3.",
                })
              }
            >
              Trigger info
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                toast.info('A new version of FortyMM is ready.', {
                  id: 'sw-update-available',
                  description: 'Reload to get the latest update.',
                  duration: Infinity,
                  action: { label: 'Reload', onClick: () => {} },
                })
              }
            >
              Trigger reload
            </Button>
          </div>
        </div>
      </Showcase>
    </Section>
  )
}

function ToastCard({
  tone,
  title,
  body,
}: {
  tone: 'success' | 'error' | 'info'
  title: string
  body: string
}) {
  const accent =
    tone === 'success'
      ? 'var(--serve-500)'
      : tone === 'error'
      ? 'var(--loss)'
      : 'var(--info)'
  return (
    <div
      className={`sonner sonner-${tone} flex w-full max-w-[360px] items-start gap-3 rounded-[10px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-4 py-3.5`}
      style={{ borderLeft: `3px solid ${accent}`, boxShadow: 'var(--shadow-lg)' }}
    >
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium text-[color:var(--fg-1)]">{title}</p>
        <p className="text-xs text-[color:var(--fg-3)]">{body}</p>
      </div>
    </div>
  )
}

/** The kit's five fixed 200×140 slides. */
const CAROUSEL_SLIDES = [1, 2, 3, 4, 5]

/** Its own component so the embla hook state lives outside the route's render
 * map (a component can't call hooks inside a `.map`).
 *
 * The kit models `.slide.on` as a *selected card* and its `1 / 5` counter as
 * "card 1 of 5" — the arrows page the selection, they don't page a viewport.
 * That distinction matters: all five 200px slides fit the ~1038px showcase
 * card, so embla has only two reachable snaps and `selectedScrollSnap()` can
 * never exceed 1. Deriving the highlight from it would freeze the counter at
 * `02 / 05` — the very bug #831 was filed against, just one click later.
 *
 * So selection is our own state (never hardcoded, per #831): the arrows move
 * it, and `scrollTo` keeps the selected card in view. That is a no-op at
 * desktop where everything already fits, and a real scroll at narrow widths
 * where it doesn't. A drag re-syncs selection from embla. */
function CarouselShowcase() {
  const [api, setApi] = useState<CarouselApi>()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const lastIndex = CAROUSEL_SLIDES.length - 1

  useEffect(() => {
    if (!api) return
    // Only a user drag re-syncs from embla. A programmatic `scrollTo` past the
    // last reachable snap gets clamped, and syncing on every `select` would
    // let that clamp overwrite the selection the arrows just set.
    const onPointerUp = () => setSelectedIndex(api.selectedScrollSnap())
    api.on('pointerUp', onPointerUp)
    return () => {
      api.off('pointerUp', onPointerUp)
    }
  }, [api])

  const select = (index: number) => {
    const next = Math.min(Math.max(index, 0), lastIndex)
    setSelectedIndex(next)
    api?.scrollTo(next)
  }

  const counter = `${String(selectedIndex + 1).padStart(2, '0')} / ${String(
    CAROUSEL_SLIDES.length,
  ).padStart(2, '0')}`

  return (
    <Carousel className="w-full" setApi={setApi} opts={{ align: 'start' }}>
      {/* Kit gap between slides is 12px (shadcn's default is 16px / `-ml-4`). */}
      <CarouselContent className="-ml-3">
        {CAROUSEL_SLIDES.map((n, index) => {
          const selected = index === selectedIndex
          return (
            <CarouselItem key={n} className="basis-auto pl-3">
              {/* Kit `.slide`: fixed 200×140, ink-700; `.slide.on`: ink-600 +
                  2px ball-500 border (no ring/glow — matches the reference). */}
              <div
                className={cn(
                  'font-display flex h-[140px] w-[200px] items-center justify-center rounded-lg text-2xl font-semibold tracking-[0.04em] text-[color:var(--fg-1)]',
                  selected
                    ? 'border-2 border-[color:var(--ball-500)] bg-[color:var(--ink-600)]'
                    : 'border border-[color:var(--border-subtle)] bg-[color:var(--ink-700)]',
                )}
              >
                {String(n).padStart(2, '0')}
              </div>
            </CarouselItem>
          )
        })}
      </CarouselContent>
      {/* Kit footer row: counter bottom-left, `‹ ›` bottom-right. Plain buttons
          rather than CarouselPrevious/Next, which page embla's viewport — here
          they page the selection (see the note above). */}
      <div className="mt-4 flex items-center justify-between">
        <span className="font-mono text-xs tracking-[0.1em] text-[color:var(--fg-3)]">
          {counter}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            aria-label="Previous slide"
            disabled={selectedIndex === 0}
            onClick={() => select(selectedIndex - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            aria-label="Next slide"
            disabled={selectedIndex === lastIndex}
            onClick={() => select(selectedIndex + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </Carousel>
  )
}

function LayoutSection() {
  return (
    <Section
      id="layout"
      title="Layout & Utility"
      lead="Structural primitives. Separators, scrollers, resizers, carousels, collapsibles."
    >
      <Showcase title="Separator" tag="horizontal · vertical">
        <div className="text-sm text-[color:var(--fg-2)]">Account settings</div>
        <Separator className="my-4" />
        <div className="text-sm text-[color:var(--fg-2)]">Privacy & data</div>
        <div className="mt-6 flex h-8 items-center gap-3 text-sm text-[color:var(--fg-2)]">
          <span>Singles</span>
          <Separator orientation="vertical" />
          <span>Doubles</span>
          <Separator orientation="vertical" />
          <span>Mixed</span>
        </div>
      </Showcase>

      <Showcase title="Collapsible" tag="show more">
        <Collapsible className="max-w-[600px]">
          <div className="flex items-center justify-between font-mono text-sm">
            <span>4 of 12 players</span>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                Show all{' '}
                <span aria-hidden="true" className="ml-1">
                  ↓
                </span>
              </Button>
            </CollapsibleTrigger>
          </div>
          <Separator className="my-3" />
          <div className="flex flex-col gap-2 text-sm">
            <div>Nguyen, Tien — 1620</div>
            <div>Okafor, Daniel — 1582</div>
            <div>Kowalski, Marta — 1505</div>
            <div>Patel, Aanya — 1488</div>
          </div>
          <CollapsibleContent className="mt-2 flex flex-col gap-2 text-sm">
            <div>Reyes, Carlos — 1462</div>
            <div>Liu, Wei — 1448</div>
            <div>Singh, Priya — 1420</div>
            <div>Park, Seo-yeon — 1411</div>
          </CollapsibleContent>
        </Collapsible>
      </Showcase>

      <Showcase title="Scroll Area" tag="styled scrollbar">
        <ScrollArea
          type="always"
          className="h-40 rounded-lg border border-[color:var(--border-subtle)] p-4"
        >
          <div className="flex flex-col gap-2 text-sm leading-loose text-[color:var(--fg-2)]">
            {Array.from({ length: 5 }, (_, round) =>
              Array.from({ length: 4 }, (_, court) => (
                <p key={`${round}-${court}`}>
                  Round {round + 1} of 5 — Court {court + 1}
                </p>
              )),
            )}
          </div>
        </ScrollArea>
      </Showcase>

      <Showcase title="Resizable" tag="drag handle">
        {/* Fixed-height wrapper: the ResizablePanelGroup's base class is `h-full`,
            which overrides a `h-40` set directly on it and collapses the panels to
            content height — so the height goes on the parent instead (#267). */}
        <div className="h-40 overflow-hidden rounded-lg border border-[color:var(--border-subtle)]">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize={30}>
              <div className="flex h-full items-center justify-center bg-[color:var(--ink-900)] text-sm text-[color:var(--fg-2)]">
                Sidebar
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={70}>
              <div className="flex h-full items-center justify-center bg-[color:var(--ink-900)] text-sm text-[color:var(--fg-2)]">
                Main canvas
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </Showcase>

      <Showcase title="Carousel" tag="slider">
        <CarouselShowcase />
      </Showcase>
    </Section>
  )
}

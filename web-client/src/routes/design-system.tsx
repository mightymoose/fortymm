import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import {
  AlertCircle,
  Calendar as CalendarIcon,
  ChevronDown,
  Check,
  Info,
  RefreshCw,
  Search,
  TriangleAlert,
  XCircle,
} from 'lucide-react'

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { AspectRatio } from '@/components/ui/aspect-ratio'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
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
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { Input } from '@/components/ui/input'
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@/components/ui/input-otp'
import { Label } from '@/components/ui/label'
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarTrigger,
} from '@/components/ui/menubar'
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from '@/components/ui/navigation-menu'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
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

export const Route = createFileRoute('/design-system')({
  component: DesignSystemPage,
})

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
  useEffect(() => {
    const cls = ['dark', 'fortymm-theme']
    document.body.classList.add(...cls)
    return () => document.body.classList.remove(...cls)
  }, [])

  return (
    <TooltipProvider>
      <div className="dark fortymm-theme min-h-screen">
        <div className="mx-auto max-w-[1200px] px-12 pt-16 pb-32">
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

      <Showcase title="Textarea" tag="resizable">
        <Label className="mb-1.5 block text-sm">Match notes</Label>
        <Textarea
          placeholder="Add context — venue, conditions, anything memorable."
          defaultValue="Played in the back hall. Andrew's forehand was on fire today — three straight games to 11."
          className="min-h-24"
        />
      </Showcase>

      <Showcase title="Input OTP" tag="6-digit">
        <InputOTP maxLength={6}>
          <InputOTPGroup>
            <InputOTPSlot index={0} />
            <InputOTPSlot index={1} />
            <InputOTPSlot index={2} />
            <InputOTPSlot index={3} />
            <InputOTPSlot index={4} />
            <InputOTPSlot index={5} />
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

      <Showcase title="Select" tag="dropdown">
        <div className="flex flex-wrap items-center gap-3">
          <Select defaultValue="singles">
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="singles">Singles</SelectItem>
              <SelectItem value="doubles">Doubles</SelectItem>
              <SelectItem value="mixed">Mixed</SelectItem>
            </SelectContent>
          </Select>
          <Select defaultValue="bo5">
            <SelectTrigger className="w-[220px]">
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
        <Command className="w-[340px] border border-[color:var(--border-subtle)]">
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
                <Button variant="outline" className="w-[220px] justify-start gap-2">
                  <CalendarIcon className="size-4" />
                  April 12, 2026
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0">
                <Calendar mode="single" />
              </PopoverContent>
            </Popover>
          </div>
          <Calendar mode="single" className="rounded-lg border border-[color:var(--border-subtle)]" />
        </div>
      </Showcase>

      <Showcase title="Toggle · Toggle Group" tag="single + multi">
        <div className="flex flex-wrap items-center gap-3">
          <Toggle defaultPressed aria-label="Bold">
            B
          </Toggle>
          <Toggle aria-label="Italic">I</Toggle>
          <Separator orientation="vertical" className="h-8" />
          <ToggleGroup type="single" defaultValue="singles">
            <ToggleGroupItem value="singles">Singles</ToggleGroupItem>
            <ToggleGroupItem value="doubles">Doubles</ToggleGroupItem>
            <ToggleGroupItem value="mixed">Mixed</ToggleGroupItem>
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

      <Showcase title="Avatar" tag="initials · stack">
        <div className="flex flex-wrap items-center gap-6">
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
              <TableHead>Player</TableHead>
              <TableHead>Club</TableHead>
              <TableHead className="text-right">Rating</TableHead>
              <TableHead className="text-right">W–L</TableHead>
              <TableHead className="text-right">Δ</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>
                <div className="flex items-center gap-2.5">
                  <Avatar className="size-7 text-xs">
                    <AvatarFallback>TN</AvatarFallback>
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
      <Showcase title="Tabs" tag="boxed">
        <Tabs defaultValue="overview">
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
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious href="#" />
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
              <PaginationNext href="#" />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </Showcase>

      <Showcase title="Navigation Menu" tag="mega-dropdown">
        <NavigationMenu>
          <NavigationMenuList>
            <NavigationMenuItem>
              <NavigationMenuTrigger>Product</NavigationMenuTrigger>
              <NavigationMenuContent>
                <ul className="grid w-[480px] grid-cols-2 gap-2 p-3">
                  <NavigationMenuLink asChild>
                    <a className="block rounded-md p-2.5 hover:bg-[color:var(--bg-hover)]">
                      <p className="text-sm font-medium">Match recorder</p>
                      <p className="text-xs text-[color:var(--fg-3)]">
                        Track scores in real time, no internet needed.
                      </p>
                    </a>
                  </NavigationMenuLink>
                  <NavigationMenuLink asChild>
                    <a className="block rounded-md p-2.5 hover:bg-[color:var(--bg-hover)]">
                      <p className="text-sm font-medium">Tournament admin</p>
                      <p className="text-xs text-[color:var(--fg-3)]">
                        SMT-solved draws and live scoring.
                      </p>
                    </a>
                  </NavigationMenuLink>
                  <NavigationMenuLink asChild>
                    <a className="block rounded-md p-2.5 hover:bg-[color:var(--bg-hover)]">
                      <p className="text-sm font-medium">Spectator brackets</p>
                      <p className="text-xs text-[color:var(--fg-3)]">
                        Shareable, public, branded.
                      </p>
                    </a>
                  </NavigationMenuLink>
                  <NavigationMenuLink asChild>
                    <a className="block rounded-md p-2.5 hover:bg-[color:var(--bg-hover)]">
                      <p className="text-sm font-medium">Club tools</p>
                      <p className="text-xs text-[color:var(--fg-3)]">
                        Member rosters, ladder leagues.
                      </p>
                    </a>
                  </NavigationMenuLink>
                </ul>
              </NavigationMenuContent>
            </NavigationMenuItem>
            <NavigationMenuItem>
              <NavigationMenuTrigger>Tournaments</NavigationMenuTrigger>
              <NavigationMenuContent>
                <ul className="grid w-[280px] gap-1 p-3">
                  <NavigationMenuLink asChild>
                    <a className="block rounded-md p-2.5 text-sm hover:bg-[color:var(--bg-hover)]">
                      Upcoming
                    </a>
                  </NavigationMenuLink>
                  <NavigationMenuLink asChild>
                    <a className="block rounded-md p-2.5 text-sm hover:bg-[color:var(--bg-hover)]">
                      Live now
                    </a>
                  </NavigationMenuLink>
                  <NavigationMenuLink asChild>
                    <a className="block rounded-md p-2.5 text-sm hover:bg-[color:var(--bg-hover)]">
                      Past results
                    </a>
                  </NavigationMenuLink>
                </ul>
              </NavigationMenuContent>
            </NavigationMenuItem>
          </NavigationMenuList>
        </NavigationMenu>
      </Showcase>

      <Showcase title="Menubar" tag="desktop app">
        <Menubar>
          <MenubarMenu>
            <MenubarTrigger>File</MenubarTrigger>
            <MenubarContent>
              <MenubarItem>New tournament</MenubarItem>
              <MenubarItem>Open…</MenubarItem>
              <MenubarItem>Export draw</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger>Edit</MenubarTrigger>
            <MenubarContent>
              <MenubarItem>Undo</MenubarItem>
              <MenubarItem>Redo</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger>View</MenubarTrigger>
            <MenubarContent>
              <MenubarItem>Show seeds</MenubarItem>
              <MenubarItem>Show ratings</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger>Tournament</MenubarTrigger>
            <MenubarContent>
              <MenubarItem>Re-run scheduler</MenubarItem>
              <MenubarItem>Lock draw</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger>Help</MenubarTrigger>
            <MenubarContent>
              <MenubarItem>Read manifesto</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>
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
      <Showcase title="Dialog · Alert Dialog" tag="modal">
        <div className="flex flex-wrap gap-3">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Open dialog</Button>
            </DialogTrigger>
            <DialogContent showCloseButton={false}>
              <DialogHeader>
                <DialogTitle>Forfeit this match?</DialogTitle>
                <DialogDescription>
                  Your opponent will be awarded the win and your rating will be
                  adjusted accordingly. This can't be undone.
                </DialogDescription>
              </DialogHeader>
              <label className="mt-5 flex items-center gap-2.5 text-sm">
                <Checkbox />
                <span>Send a note to my opponent</span>
              </label>
              <DialogFooter>
                <Button variant="outline">Cancel</Button>
                <Button variant="destructive">Forfeit</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">Delete account…</Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="w-[380px]">
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2.5">
                  <TriangleAlert className="size-5 text-[color:var(--warn)]" />
                  Delete account
                </AlertDialogTitle>
                <AlertDialogDescription>
                  All match history, ratings, and tournament records will be
                  permanently deleted.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep account</AlertDialogCancel>
                <AlertDialogAction variant="destructive">
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </Showcase>

      <Showcase title="Sheet" tag="side panel">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline">Open filters</Button>
          </SheetTrigger>
          <SheetContent side="right" showCloseButton={false}>
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
              <SheetDescription>Narrow the player list.</SheetDescription>
            </SheetHeader>
            <div className="mb-[18px]">
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
            <SheetFooter>
              <Button className="w-full">Apply filters</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </Showcase>

      <Showcase title="Drawer" tag="mobile bottom sheet">
        <Drawer>
          <DrawerTrigger asChild>
            <Button variant="outline">Quick log</Button>
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Quick log</DrawerTitle>
              <DrawerDescription>
                Tap to record a finished match.
              </DrawerDescription>
            </DrawerHeader>
            <DrawerFooter>
              <Button>Pick opponent</Button>
              <Button variant="outline">Cancel</Button>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      </Showcase>

      <Showcase title="Popover" tag="contextual content">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline">Skill rating info</Button>
          </PopoverTrigger>
          <PopoverContent>
            <h4 className="mb-1 text-sm font-semibold">Skill rating</h4>
            <p className="text-xs text-[color:var(--fg-3)]">
              Your rating is calculated using a Glicko-2 system with a 0.06
              volatility cap. Updates after every match.
            </p>
          </PopoverContent>
        </Popover>
      </Showcase>

      <Showcase title="Tooltip" tag="on hover">
        <div className="flex items-center gap-16">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Refresh">
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh standings</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge>Seed 1</Badge>
            </TooltipTrigger>
            <TooltipContent>Highest rated player in this bracket</TooltipContent>
          </Tooltip>
        </div>
      </Showcase>

      <Showcase title="Hover Card" tag="player preview">
        <HoverCard>
          <HoverCardTrigger asChild>
            <Button variant="link">@nguyen.t</Button>
          </HoverCardTrigger>
          <HoverCardContent className="w-[280px]">
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
          </HoverCardContent>
        </HoverCard>
      </Showcase>

      <Showcase title="Dropdown · Context Menu" tag="right-click + chevron">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                Match actions <ChevronDown className="ml-1 size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Match actions</DropdownMenuLabel>
              <DropdownMenuItem>
                Rematch
                <DropdownMenuShortcut>⌘R</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem>
                Share match link
                <DropdownMenuShortcut>⌘⇧S</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem>Edit score</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-[color:var(--loss)]">
                Forfeit
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-[color:var(--border-subtle)] text-sm text-[color:var(--fg-3)]">
                Right-click here
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem>
                <Check className="mr-2 size-4" /> Show seeds
              </ContextMenuItem>
              <ContextMenuItem>Show ratings</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem>Reschedule…</ContextMenuItem>
              <ContextMenuItem>Print bracket</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>
      </Showcase>

      <Showcase title="Command" tag="cmd+k palette">
        <Command className="w-[480px] border border-[color:var(--border-subtle)]">
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
            <AlertTitle>Match disputed</AlertTitle>
            <AlertDescription>
              A player has filed a score dispute. Review the appeal in the admin
              panel.
            </AlertDescription>
          </Alert>
          <Alert className="border-[color:var(--serve-500)]/40 bg-[color:var(--serve-500)]/10">
            <AlertCircle className="text-[color:var(--serve-500)]" />
            <AlertTitle className="text-[color:var(--serve-500)]">
              Match logged
            </AlertTitle>
            <AlertDescription>
              Your rating moved from 1602 to 1620 (+18).
            </AlertDescription>
          </Alert>
        </div>
      </Showcase>

      <Showcase title="Sonner / Toast" tag="3 variants">
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
      className="flex items-start gap-3 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-4 py-3.5"
      style={{ borderLeft: `3px solid ${accent}`, boxShadow: 'var(--shadow-lg)' }}
    >
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium text-[color:var(--fg-1)]">{title}</p>
        <p className="text-xs text-[color:var(--fg-3)]">{body}</p>
      </div>
    </div>
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
                Show all <ChevronDown className="ml-1 size-3.5" />
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
        <ScrollArea className="h-40 rounded-lg border border-[color:var(--border-subtle)] p-4">
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
        <ResizablePanelGroup
          orientation="horizontal"
          className="h-40 rounded-lg border border-[color:var(--border-subtle)]"
        >
          <ResizablePanel defaultSize={30}>
            <div className="flex h-full items-center justify-center bg-[color:var(--ink-900)] text-sm text-[color:var(--fg-2)]">
              Sidebar
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={70}>
            <div className="flex h-full items-center justify-center bg-[color:var(--ink-900)] text-sm text-[color:var(--fg-2)]">
              Main canvas
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </Showcase>

      <Showcase title="Carousel" tag="slider">
        <Carousel className="w-full">
          <CarouselContent>
            {[1, 2, 3, 4, 5].map((n) => (
              <CarouselItem key={n} className="basis-1/3">
                <div className="font-display flex h-32 items-center justify-center rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--ink-700)] text-2xl tracking-[0.04em] text-[color:var(--fg-1)]">
                  {String(n).padStart(2, '0')}
                </div>
              </CarouselItem>
            ))}
          </CarouselContent>
          <CarouselPrevious />
          <CarouselNext />
        </Carousel>
      </Showcase>
    </Section>
  )
}

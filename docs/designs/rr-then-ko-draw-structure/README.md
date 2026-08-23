# Round-robin then knockout: the draw-structure reference

The interactive reference for issue #1320 lives at
`https://fortymm-draw-structure.mightymoose.chatgpt.site/`. That site is outside this
repo and can change or go away. This file records what the reference specifies, so the
implementation has a fixed target.

The copy and the math below come from the reference's own bundle
(`/assets/page-CZ2t-Xlt.js`), not from reading the rendered page. Treat the strings as
exact.

**The apostrophes are exact too.** Every one in the reference's copy is a right single
quote, `U+2019`, with one exception: `today's behaviour` uses a straight `U+0027`. Do
not normalise either way. A test that pins this copy fails on the wrong glyph, which is
the point.

Read `../rr-then-ko-current-state/README.md` first. It records the editor this work
replaces.

## The screenshots

Captured from the reference at 1280x800, at twice the pixel density.

| File | What it shows |
| --- | --- |
| `nothing-set.png` | 32 players, 4 reservations, every setting automatic — the four derived groups show the **reference's** count rule, not ours (see "What the reference does not settle", item 4) |
| `uneven-field.png` | 22 players across 4 pools |
| `uneven-field-panel.png` | the same state, scrolled to the uneven notice |
| `numbers-disagree.png` | 40 players, 6 manual pools of 5 manual |
| `numbers-disagree-panel.png` | the same state, scrolled to the three fixes |
| `field-too-small.png` | 8 players across 6 pools |
| `field-too-small-panel.png` | the same state, scrolled to the refusal |
| `cut-and-assign.png` | the cut screen, dealing by snake |
| `cut-assign-by-hand.png` | the cut screen, one entrant selected |

## The shape of the screen

The reference adds a fifth tab to the event editor. The tab list stays horizontal:

```
Basics · Eligibility · Match settings · Table pools · Draw structure
```

The `Draw structure` tab holds two columns inside the existing wide editor.

The left column carries a heading block and then four setting rows. The rows share one
list and use dividers, not cards.

- Overline: `Draw structure`
- Heading: `Set what matters. We’ll work out the rest.`
- Body: `Pools play all-play-all. The top finishers move into a knockout bracket.`
- Preview basis block: label `Preview field`, the field size, and a link
  `Change in Basics`

The right column carries one sticky preview. Below the two columns sits the existing
action bar.

## A setting row

Each of `Pool count`, `Pool size` and `Qualifiers per pool` uses one pattern:

| Part | Content |
| --- | --- |
| Name | The setting name |
| Hint | One short line under the name |
| Value | A read-only number when automatic, a text input when manual |
| Unit | Plain words after the value |
| Badge | `Automatic` or `Yours` |
| Source | One line saying where the value came from |
| Action | A quiet text button, `Set myself` or `Use automatic` |

The manual control is `<input type="text" inputMode="numeric">` with an accessible name.
There are no plus or minus buttons anywhere.

Switching a row to manual seeds the input from the current derived value. Pool count
seeds from the derived count. Pool size seeds from the largest derived pool. Qualifiers
seed from the derived qualifier count.

### Row copy

**Pool count**

- Hint: `How many pools the field splits into. Each pool also books its tables and time window.`
- Unit: `pool` or `pools`
- Source when manual: `You set this. Each pool also gets a reservation.`
- Source when automatic and pool size is manual: `{field} players ÷ about {size} per pool`
- Source when both are automatic: `{n} pool reservations · today's behaviour`

**Pool size**

- Hint: `The target number of players in each pool.`
- Value when even: the pool size. Value when uneven: `{min}–{max}`
- Unit when even: `players per pool`. Unit when uneven: `players · uneven`
- Source when both are manual: `You set this.`
- Source when only size is manual: `You set the target. We derived the pool count.`
- Source when automatic: `{field} players ÷ {count} pools`

**Membership**

This row has no numeric input. It shows one of two values.

- Hint: `Who lands in each pool. Entrants do not exist until you cut the draw.`
- Automatic value: `Snake automatically`, source `Seeds spread 1, 2, 3, 3, 2, 1.`
- Manual value: `Assign at cut time`, source `You’ll place entrants once registration closes.`
- Action: `Assign myself` or `Use snake`
- When manual, the row also shows: `Repeat protection turns off when you assign pools by hand.`

**Qualifiers per pool**

- Hint: `How many finishers from each pool reach the knockout.`
- Unit: `through from each pool`
- Source when manual: `You set this.`
- Source when automatic: `Aiming at an 8-player knockout across {count} pools.`

## The derivation

The reference computes everything from eight inputs: the field size, the pool
reservation count, the three ownership modes, and the three manual numbers. The target
bracket size is the constant `8`.

### Pool count

```
manual            -> max(1, manualPoolCount)
size is manual    -> max(1, ceil(field / max(1, manualPoolSize)))
otherwise         -> max(1, poolReservationCount)
```

### Pool sizes

When both modes are manual, every pool takes the manual size:

```
sizes = [manualPoolSize] * poolCount
```

When only pool size is manual, fill each pool to the manual size in turn and let the
last pool take what is left:

```
remaining = field
for each pool: take min(manualPoolSize, remaining)
```

This is a greedy fill, not a balanced split. A field of 41 across pools of 5 gives
`5,5,5,5,5,5,5,5,1`, and the pool of one is then an impossible competition.

When pool size is automatic, split the field evenly and give the extra players to the
earliest pools:

```
base = floor(field / count)
extra = field % count
sizes[i] = base + (1 if i < extra else 0)
```

- 22 across 4 gives `6, 6, 5, 5`
- 40 across 6 gives `7, 7, 7, 7, 6, 6`

### Qualifiers, bracket and byes

```
qualifiers = manual ? max(1, manualQualifiers) : max(1, ceil(8 / poolCount))
bracket    = poolCount * qualifiers
byes       = 2 ^ ceil(log2(max(2, bracket))) - bracket
```

### Pool matches

```
poolMatches = sum over pools of n * (n - 1) / 2
```

Four pools of eight give 112.

### Disagreement

A disagreement exists only when both pool count and pool size are manual and their
product does not equal the field:

```
seats = poolCount * poolSize
conflict = (countManual and sizeManual and seats != field)
```

### Uneven

```
uneven = (not conflict) and min(sizes) != max(sizes)
```

### Impossible

Test in this order and report the first hit only:

1. `min(sizes) < 2`
2. `bracket < 2`
3. `qualifiers > min(sizes)`

## The three panels

Only one panel shows at a time. The order above decides which.

### Impossible

Role `alert`. Topline `Can’t save` with a red dot.

| Case | Title | Body |
| --- | --- | --- |
| Pool | `Pool {letter} would have one player` (or `no players`) | `They would have nobody to play. Use fewer pools or raise the player limit.` |
| Bracket | `The knockout would have one player` | `One player has nobody to play. Take more qualifiers or run more pools.` |
| Qualifier | `You can’t take {q} qualifiers from a pool of {min}` | `Take {min} or fewer, or make the smallest pool bigger.` |

Fixes offered:

- Pool case: `Use {floor(field / 2)} pools` with detail `Every pool gets at least two players.`,
  and `Raise the player limit to {count * 2}` with detail `Keeps your pool count.`
- Bracket case: `Take top 2` with detail `Creates a playable knockout.`
- Qualifier case: `Take top {min}` with detail `Fits the smallest pool.`

Each fix is a row with a label, a detail line and an `Apply` button.

### Disagreement

Role `status`. Topline `Needs your call` with a yellow dot.

- Title: `{count} pools of {size} seat {seats}. Your field is {field}.`
- Body when the field is bigger: `{n} entrants have nowhere to go. We won’t change your numbers behind your back.`
- Body when the field is smaller: `{n} seats would be empty. We won’t change your numbers behind your back.`

Three fixes:

1. `Cap the field at {seats}` · `Your structure stays exact.`
2. `Use {ceil(field / size)} pools of {size}` · `Everyone gets a seat.`
3. `Allow uneven pools` · the balanced split tallied largest first, then the word
   `players`. A field of 40 across 6 pools reads `4 × 7 and 2 × 6 players.`

`Allow uneven pools` returns pool size to automatic and keeps the manual pool count.

### Uneven

Role `status`. Topline `Legal, but uneven` with a blue dot.

- Title: the size tally, joined with ` · `, as `2 pools of 6 · 2 pools of 5`
- Body: `The bigger pools play more matches. Nothing has been silently reshaped.`

## The live preview

Overline `The draw as it stands`. The heading and the badge follow the state:

| State | Heading | Badge |
| --- | --- | --- |
| Impossible | `This draw can’t work yet` | `Impossible` |
| Disagreement | `Your numbers disagree` | `Your call` |
| Otherwise | `Ready to save` | `Sound` |

Below that, in order:

1. The equation: `{field} players ÷ {count} pools = {size} per pool`. The size reads
   `{min}–{max}` when the pools are uneven.
2. Pool cards, at most eight. Each shows `Pool {letter}`, the size, the word `players`,
   and `top {q} advance`. A card reads as bad when its size is under two or under the
   qualifier count.
3. A down arrow.
4. The knockout card: `Knockout`, `{bracket}-player bracket`, then either
   `No first-round byes` or `{n} first-round bye(s)`, then `{n} pool matches`.
5. Three facts: `Pool reservations`, `Membership` (`Snake` or `By hand at cut`), and
   `Preview basis`.
6. When membership is manual: `Repeat protection is off` with
   `A first-round knockout may repeat a pool match.`
7. Foot: `Entrants are placed only when registration closes and you cut the draw.` and
   a link `Preview cut-time assignment →`.

The reference labels the preview basis `{n}-player cap` in every state. Issue #1320
requires an honest label when the event has no cap. Use `{n}-player cap` when a cap
exists, and `16 players because this event has no cap` when none does.

## The action bar

- A state line: `Unsaved changes`, or `Saved` with a green dot.
- `Cancel`
- A primary button. It reads `Save changes`, or `Fix the structure to save` when the
  configuration is impossible. It is disabled when the configuration is impossible.

## Cut time

The reference reaches this state through the preview's link. In the product it is the
cut screen, and it uses the real registered field.

The header carries a chip: `Registration closed · {n} entrants`.

Intro block:

- Back link: `← Back to event settings`
- Overline: `Membership`
- Heading: `Place the field, then cut.`
- Body: `Pool identities and matches freeze when you cut. You can re-cut before the tournament goes live.`

A radio group named `Pool membership method` offers two choices:

1. `Deal by snake` · `Seeds spread 1, 2, 3, 3, 2, 1. Repeat protection stays on.` ·
   marked `Recommended`
2. `Assign by hand` · `Pick an entrant, then pick their pool.`

Choosing snake shows a snake preview: a seed-order line, then one block per pool listing
the entrants that land there.

Choosing by hand shows a warning that stays on screen:

```
Repeat protection turns off.
A first-round knockout match may repeat a pool match. We’ll flag it, not block it.
```

The assignment area holds two panes.

The left pane lists unplaced entrants. Its header shows `Entrants` and `{n} unplaced`,
plus a button `Snake-fill the rest`. Each entrant row shows the seed, the name and the
rating. Clicking a row selects it. When the list empties it reads `Everyone has a pool.`

The right pane holds one button per pool. Each shows `Pool {letter}`, a
`{placed} / {target}` count, and the entrants already placed. An empty pool reads
`No one yet`, or `Place here` when an entrant is selected. Clicking a pool places the
selected entrant.

`Snake-fill the rest` keeps every hand placement and deals the remaining entrants by
snake.

The cut action bar shows either `{n} entrants still need a pool` or
`Ready to cut · group identities will freeze`. The `Cut draw` button is disabled while
any entrant is unplaced.

After the cut: `Draw cut.` with `4 pools · 40 pool matches · 8-player knockout`.

## The reference's five states

| State | Field | Reservations | Count | Size | Qualifiers | Modes |
| --- | --- | --- | --- | --- | --- | --- |
| Nothing set | 32 | 4 | 4 | 8 | 2 | all automatic |
| Uneven field | 22 | 4 | 4 | 6 | 2 | all automatic |
| Numbers disagree | 40 | 6 | 6 | 5 | 1 | all manual |
| Field too small | 8 | 6 | 6 | 2 | 1 | count and qualifiers manual |
| Cut and assign | 20 | 4 | 4 | 5 | 2 | membership manual |

## What the reference does not settle

1. **A derived pool count has no reservation rows.** The reference shows
   `max(reservationCount, derivedCount)` and stops there. A real pool row needs a name,
   a position, a date, a window and tables.
2. **The target bracket size is the constant 8.** Nothing in the reference writes it.
3. **The preview basis label** always says `cap`, even when the field is the uncapped
   default of 16.
4. **Divergence (#1386, 2026-08-17): the automatic count no longer follows the
   reference.** The reference derives it from the reservation row count
   (`max(1, poolReservationCount)`, "The derivation" above). The implementation
   instead divides the field by a default group size of five —
   `max(1, ceil(field / 5))` — and balances the sizes across that count, so an
   out-of-the-box event stays legal (a field of 16 gives four groups of four, where
   filling to five greedily would leave a group of one). Two row sentences are
   therefore ours, not the reference's: the automatic count source reads
   `{field} players ÷ about 5 per group`, and the manual one reads `You set this.`
   — the reference's reservation clause is gone because the derivation stops
   reading reservations. "The derivation" and "Row copy" above are unchanged: they
   record the reference, and this note records where the implementation departs.
5. **Divergence (#1425, 2026-08-22): a third badge and a fourth verdict, for the
   qualifiers setting nobody has chosen.** The reference specifies two badges
   (`Automatic` / `Yours`) and three preview verdicts ("The verdict" above), and its
   qualifier rule always has a number to work from. A real event does not until the
   director types one on Basics. So:
   - `SettingOwnership` gains a third value, `unset`, badged **`Unset`**. It never
     falls through to the automatic rule — an invented number under an `Automatic`
     badge is the defect this records.
   - With no count chosen, the qualifiers row reads **`Not set`** (no unit) sourced
     **`You choose this in Basics.`**; each group card reads **`qualifiers not set`**
     instead of `top {n} advance` and is never marked `Too small` for it; the
     knockout card reads **`Not set`**, states no bracket size and no byes, and keeps
     its group-match total.
   - The preview gains a fourth verdict: heading **`Choose your qualifiers`** with
     badge **`Incomplete`**, in the warning tint. Verdict precedence becomes:
     impossible → incomplete → your call → sound.
   - With no count, only a `group` impossible problem can fire: the bracket and
     qualifier rules both need a number to compare against.
   - The reference's own copy above is unchanged; this note is the divergence of
     record, as with item 4.

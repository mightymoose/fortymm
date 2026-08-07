# Design brief: FortyMM transactional email templates

## What FortyMM is

FortyMM is a web and iOS app for table tennis. Players record matches, earn a rating, and run
tournaments. Tournament directors build draws and call players to tables. A person can play as a
guest first, then claim an email address to keep their matches and rating.

## What we need

Design one HTML email system that covers five emails. All five go out today as plain text with no
layout and no branding. We want one shared wrapper and one set of components, not five separate
designs.

## The five emails

Each block below gives the current subject line and the current body. Treat the copy as the
message we must carry. You may rewrite the copy. Flag any rewrite so we can review it.

### 1. Confirm your email

- Subject: `Confirm your FortyMM email`
- Trigger: a signed-in guest enters an email address to claim their account.
- Body:

```
Hi @{username},

Click the link below to confirm your email address and claim your FortyMM account.

{confirm_url}

If you didn't request this, you can ignore this email.
```

### 2. Sign-in link

- Subject: `Your FortyMM sign-in link`
- Trigger: a returning player asks for a magic link.
- Body:

```
Hi @{username},

Click the link below to sign in to FortyMM. The link is good for 15 minutes and only works once.

{login_url}

If you didn't ask to sign in, you can ignore this email — nobody can use the link without your
inbox.
```

### 3. No account for this address

- Subject: `About your FortyMM sign-in request`
- Trigger: someone asks for a sign-in link for an address with no account. We send this so a real
  person who typed the wrong address learns why nothing arrived. We also send it so an attacker
  cannot tell which addresses exist by watching for an empty inbox.
- Body:

```
Hi,

Someone — probably you — asked for a sign-in link for this email address, but there's no FortyMM
account tied to it yet.

To get started, open FortyMM and start playing as a guest, then claim this email address in
Settings to keep your matches and rating.

{app_url}

If you didn't request this, you can safely ignore this email.
```

- Note: this email carries no token. The link goes to the app home page. The link is also
  optional, so design a state without it.

### 4. Link your guest session to an existing account

- Subject: `Sign in to your FortyMM account`
- Trigger: a guest enters an email address that already belongs to an account.
- Body:

```
Hi @{username},

Someone — probably you — entered this email while playing FortyMM as a guest. Click the link below
to sign in to your existing account. We'll bring any matches from that guest session along with
you.

{confirm_url}

If this wasn't you, you can ignore this email. Nobody can sign in or move anything without this
link.
```

### 5. Notification

- Subject: `FortyMM · {title}`
- Trigger: a player opted into email for a notification category. This one email template serves
  every category, so the design must hold a variable title, a variable body, and an optional link.
- Body:

```
{title}

{body}

{deep_link}

Manage which notifications reach you in FortyMM → Settings → Notifications.
```

- The six categories are: match reminder, rating change, tournament, opponent, result confirm, and
  match calls.
- Real examples of `{title}`:
  - `You're up soon — Table 4`
  - `Your match moved to Table 7`
  - `Your match was cancelled`
- The deep link is optional. Design a state with the button and a state without it.

## Brand

The app runs a dark theme. These are the live tokens.

| Token | Value | Role |
| --- | --- | --- |
| `--ink-950` | `#0b0d12` | app background |
| `--ink-900` | `#11141b` | panel |
| `--ink-800` | `#171b24` | card |
| `--ink-600` | `#2a3040` | subtle border |
| `--ink-400` | `#535b6e` | disabled text |
| `--ball-500` | `#ff7a1a` | primary, the ball orange |
| `--ball-600` | `#e85e00` | primary hover |
| `--ball-400` | `#ff9a4a` | accent text on dark |
| `--ball-200` | `#ffcfa8` | soft accent |
| `--ball-50` | `#fff4ed` | tint |

- UI typeface: Space Grotesk.
- Display typeface: Bebas Neue.
- Mono typeface: JetBrains Mono.
- Corner radius: 10px base.
- The UI kit mockup is `docs/designs/design-system.html`. Open it in a browser. Its arrows are
  decorative, not flow.

### The existing wordmark

We already have a wordmark in code. Match it.

- The word is `FORTYMM`, set as one word with no space.
- `FORTY` takes the foreground colour. `MM` takes the ball orange, `#ff7a1a`.
- The face is the display face, Bebas Neue.
- Letter spacing is `0.06em`.
- The app renders it at 24px in the header and 22px elsewhere.
- Source: `web-client/src/components/wordmark.tsx`.

### Sender identity

The From address is a deploy setting, not a fixed value in the code. Ask us for the production
value before you design the header. Design the header so it reads correctly next to a `noreply@`
sender, because that is what we send from today.

## Constraints

Read these before you start. Each one changes the design.

### Use a light background, not the app's dark one

The app is dark-first. Email clients are not. Many clients apply their own dark-mode inversion and
mangle a hand-built dark email. Design on white or a near-white ground. Use the orange as the
accent. If you want to offer a dark variant, treat it as a second deliverable, not the default.

### Always show the raw URL as text

Every email carries a link. Four of the five carry a one-time sign-in or confirmation token.

Put a button in. Also print the full URL as visible text below it. Two reasons:

1. A person who can read the real domain can spot a fake FortyMM email. A design that hides every
   URL behind a styled button trains people to click without looking.
2. Corporate link scanners prefetch button targets. A prefetch can burn a one-time token before
   the person clicks. A visible URL gives them a second way through.

### No SVG, and no exported logo file

Gmail strips SVG. The wordmark above lives in code as styled text, not as an image asset. The only
image file we hold is `web-client/public/favicon.svg`, which email clients will not render.

Please deliver the wordmark as PNG at 1x, 2x, and 3x, or specify it as text-only in the fallback
font stack. Text-only is acceptable. It also survives the case where a client blocks images.

### Web fonts will not load

Most email clients ignore `@font-face`. Space Grotesk and Bebas Neue will fall back. Pick the
fallback stack yourself and design against it. Do not rely on the brand typefaces for anything
load-bearing.

### Build for table-based HTML with inline CSS

Outlook on Windows uses the Word rendering engine. It ignores flexbox, grid, most `padding` on
`div`, and background images. Design something that survives a table layout with inline styles. Our
engineers hand-code the template. There is no email framework in the stack.

### Every email needs a plain-text twin

We send `multipart/alternative`. The plain-text part must carry the same message. Keep the design
simple enough that the text version is not a downgrade in meaning.

### Every email needs preheader text

Most clients print a preview line next to the subject in the inbox list. If we leave it undefined,
the client grabs whatever text comes first, which is usually the wordmark or a footer link. Write
one preheader line per email. It sits in a hidden block at the top of the wrapper.

### Width and dark-mode behaviour

- Target 600px maximum content width.
- Design a single-column layout. Two-column layouts break on mobile in several clients.
- Show us how the design should look when a client inverts colours.

## Deliverables

1. A wrapper: hidden preheader, header, footer, and the shell every email shares.
2. Components: a heading, a paragraph, a primary button, a visible-URL block, and a muted footnote
   block.
3. Five composed emails, one per section above, using those components.
4. The notification email in two states: with a deep link and without.
5. The no-account email in two states: with a link and without.
6. One preheader line for each email and each state above.
7. A wordmark as PNG at 1x, 2x, and 3x, or a specified text-only wordmark.
8. A spec sheet: hex values, pixel spacing, font sizes, and the fallback font stack.

## Out of scope

- Marketing or campaign email. All five emails are transactional.
- A preference centre page. Settings already exists in the app.
- Any change to when we send these emails or to who receives them.

## Reference

- Current implementation and copy: `api/app/email.py`.
- Brand tokens: `web-client/src/index.css`.
- UI kit: `docs/designs/design-system.html`.

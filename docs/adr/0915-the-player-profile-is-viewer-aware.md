# The player profile is viewer-aware

The profile page renders differently depending on who is looking at it. Until now
it did not: the component never touched the session, and the API bound the caller
as `_current_user` — the underscore marking it deliberately unused. Every viewer
got a byte-identical page.

That was defensible when the page was a hero and a table. It stops being
defensible the moment the page carries a **head-to-head** card, because a
head-to-head is only meaningful *from a stated side*. On someone else's profile,
"perky-ringtail is 2–2 against swift-lynx" answers a question nobody asked. The
question you actually opened their profile to ask is **"how do I do against
them, and shall we play right now?"**

So:

- **Viewing someone else** — the head-to-head card leads with **your** record
  against them, then lists their frequent opponents as secondary context. If
  you've never played them, it degrades to "You haven't played perky-ringtail
  yet" and offers **Start a match**, prefilled with them as the opponent.
- **Viewing yourself** — no self-head-to-head; the card is just "Frequent
  opponents". Copy that addresses the player ("A reliable read on where *you*
  stand") is second person here and third person everywhere else.

## Considered options

- **Viewer-aware, minimally (chosen).** The API already has the caller; using it
  costs one `useSession` in the component tree and one extra aggregation
  server-side. It buys the page its single most useful card and the app's only
  "challenge this person" affordance.
- **Keep it impersonal — one page, same for everyone.** Less code, no session in
  the tree, and the profile stays trivially cacheable. Rejected: it makes the
  head-to-head card decorative on precisely the profiles people visit most
  (other people's), and it forces the confidence card into third-person copy on
  your *own* profile, where second person is obviously right.
- **Two routes — `/players/$id` and `/me`.** Rejected as a worse version of the
  same thing: it duplicates nine cards to vary two of them, and it still doesn't
  answer what a *guest* sees.

## Consequences

The profile response now varies by caller, so it is **not** shareable across
users by any cache in front of it. It never was safe to share (the endpoint has
always required a session), but the page's payload was previously identical for
everyone, and that accident is now load-bearing in the other direction.

A **guest** — anyone who lands on a profile link gets a session minted for them —
has played nobody, so the "You vs them" block is *always* in its empty state for
them. That state must therefore be good, not an afterthought: it is the first
thing a brand-new visitor sees, and its "Start a match" CTA is the app's best
conversion moment.

Viewing your own profile is now reachable: this refactor adds the "your profile"
link to the user menu, which the app has never had. Until now the only way to see
your own profile was to find yourself on the roster and click your own row.

The self-profile is the edge case to remember when adding any new card: the
answer to "what does this show when the player *is* the viewer?" is never
"nothing" by default — it has to be decided.

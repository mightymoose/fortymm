---
status: accepted
supersedes: ADR-0783 §3
---

# An unrated player fails a rating rule that sets a lower bound

ADR-0783 §3 let an unrated player pass every rating rule. QA found that an unrated
player entered events with rules such as `Rating >= 2800`, and (#1635) a sandbagger
could stay unrated forever and enter every event with a floor.

We now split the rules by direction. An unrated player **fails** a rule that sets a
lower bound: `>`, `>=`, `=`, and `between` with a minimum. An unrated player
**passes** a rule that sets only an upper bound: `<`, `<=`, `!=`, and `between` with
only a maximum. Rules stay ANDed, so `>= 2800 AND < 1500` refuses an unrated player.
A rule with no number constrains nobody.

## Considered options

- Keep ADR-0783 §3. Rejected: a floor is a claim about a rating, and an unrated
  player has none to show.
- Fail every rating rule. Rejected: it bars a brand-new player from the "Under 1500"
  beginners' event, which exists for them.
- Treat unrated as rating 0. Rejected: it guesses a rating we do not hold.
- Add an "allow unrated" toggle to each rule. Deferred: open a ticket if organizers
  ask for it.

## Consequences

- A cap is still opt-out. The entrants list still marks unrated entrants for the
  director.
- The refusal payload `rating_ineligible` carries `rating: null` for an unrated
  player. The web client and iOS say "You have no rating yet."
- The event card, the event editor and iOS state the rule in text.
- No migration. Existing unrated entrants in restricted events stay in place, and the
  director can withdraw them. A paid entry from before this change that the payment
  re-check now refuses becomes a refund line.

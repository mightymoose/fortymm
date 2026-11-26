// Example of the pattern for checking requirements for gaps. Replace it with real requirements.
//
//   1. Each requirement is a named predicate over the system state.
//   2. Consistency: one concrete witness state satisfies all of them, so they don't contradict.
//   3. Preservation: every operation keeps every requirement true from any valid state.
//   4. Coverage: every operation says what happens in every valid state, with no unhandled case.

module Example {
  datatype Event = Event(capacity: nat, attendees: set<string>, waitlist: seq<string>)

  // REQ-1: an event never holds more attendees than its capacity.
  ghost predicate WithinCapacity(e: Event) { |e.attendees| <= e.capacity }

  // REQ-2: someone is never both attending and waitlisted.
  ghost predicate NoDoubleBooking(e: Event) {
    forall i :: 0 <= i < |e.waitlist| ==> e.waitlist[i] !in e.attendees
  }

  // REQ-3: the waitlist only has people on it while the event is full.
  ghost predicate WaitlistOnlyWhenFull(e: Event) {
    |e.waitlist| > 0 ==> |e.attendees| == e.capacity
  }

  ghost predicate Valid(e: Event) {
    WithinCapacity(e) && NoDoubleBooking(e) && WaitlistOnlyWhenFull(e)
  }

  // Consistency: the requirements can all hold at once, even on a busy event.
  lemma RequirementsAreConsistent()
    ensures Valid(Event(1, {"ana"}, ["ben"]))
  {}

  // Coverage + preservation: joining is defined for every valid state and keeps it valid.
  function Join(e: Event, who: string): Event
    requires Valid(e)
    ensures Valid(Join(e, who))
  {
    if who in e.attendees || who in e.waitlist then e
    else if |e.attendees| < e.capacity then e.(attendees := e.attendees + {who})
    else e.(waitlist := e.waitlist + [who])
  }
}

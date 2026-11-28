// The journal's sync decisions (DESIGN-primitives.md, section 5): which held records a sync cycle
// sends, and how the server's reply changes the journal. Pure functions, as the core will hold them
// (section 14: "Journal and sync decisions ... the core only decides").
//
// Agreed scope, matching requirements/tla/Journal.tla:
//   - A record is Held or Acknowledged with the answer the server gave. There is no "malformed"
//     and no stuck state: commit verifies its own output (4.5), so the device never holds one.
//   - Only whether a record is a temporary score matters to sending (5, Backlogs; J7).
//   - Out: cancel and "has left the device" (5.3), parcel splitting (P1), byte sizes, backoff.
//
// Pattern (see Example.dfy): named requirements, a consistency witness, and every operation
// defined for every valid journal (coverage) and keeping every requirement (preservation).

module SyncDecisions {
  type Id = nat

  datatype Kind = Score | Other

  // An answer the server stores with a record and gives again on every repeat (7, Answers):
  // `held` (Holds), `applied`, or `refused` with a reason code, which is kept with the record too.
  type Reason = nat

  datatype Answer = Holds | Applied | Refused(reason: Reason)

  // One record's answer in a reply. RetryLater stores nothing (7, Flood control).
  datatype ReplyAnswer = Answered(answer: Answer) | RetryLater

  datatype State = Held | Acknowledged(answer: Answer)

  datatype Entry = Entry(id: Id, kind: Kind, state: State)

  // In the order the records entered the journal: the index is the journal's counter (5.4).
  type Journal = seq<Entry>

  // The parcels reply: one answer per record of the parcel, by record id, in the parcel's order.
  type Reply = seq<(Id, ReplyAnswer)>

  datatype Option<T> = None | Some(value: T)

  // ---------------------------------------------------------------------------------------------
  // Requirements on the journal

  // REQ-UNIQUE: no two entries have the same record id. The journal is keyed by record id (5.4),
  // and every record has its own random value, so the same action twice is two ids (D22).
  ghost predicate UniqueIds(j: Journal) {
    forall a, b :: 0 <= a < |j| && 0 <= b < |j| && a != b ==> j[a].id != j[b].id
  }

  ghost predicate Valid(j: Journal) { UniqueIds(j) }

  predicate IsHeld(e: Entry) { e.state.Held? }

  function Ids(j: Journal): set<Id> { set e | e in j :: e.id }

  // ---------------------------------------------------------------------------------------------
  // Commit (5.3): append one held record at the end. Returns only once it is in the journal (J3).

  function Commit(j: Journal, id: Id, kind: Kind): Journal
    requires Valid(j)
    requires id !in Ids(j)
    ensures Valid(Commit(j, id, kind))
    // REQ-COMMIT-APPENDS: what was there is unchanged and in the same order (J4, J7), and the new
    // record is the last entry, held (J3).
    ensures Commit(j, id, kind) == j + [Entry(id, kind, Held)]
  {
    var j' := j + [Entry(id, kind, Held)];
    assert forall a :: 0 <= a < |j| ==> j'[a] == j[a] && j[a] in j;
    j'
  }

  // ---------------------------------------------------------------------------------------------
  // NextBatch (5, Backlogs; J7): everything but temporary scores first, in journal order, then
  // temporary scores in journal order, at most `limit` records a cycle.

  // REQ-SEND-ORDER: entry a must leave no later than entry b. A non-score goes before every score;
  // two records of the same kind go in journal order.
  ghost predicate SendsBefore(j: Journal, a: nat, b: nat)
    requires a < |j| && b < |j|
  {
    (j[a].kind == Other && j[b].kind == Score) || (j[a].kind == j[b].kind && a < b)
  }

  // The held entries of one kind, at index `from` or later, in journal order.
  function HeldOfKind(j: Journal, k: Kind, from: nat): seq<nat>
    requires from <= |j|
    decreases |j| - from
  {
    if from == |j| then []
    else (if IsHeld(j[from]) && j[from].kind == k then [from] else []) + HeldOfKind(j, k, from + 1)
  }

  function SendOrder(j: Journal): seq<nat> {
    HeldOfKind(j, Other, 0) + HeldOfKind(j, Score, 0)
  }

  function Min(a: nat, b: nat): nat { if a < b then a else b }

  // The batch as journal indices. NextBatch gives their record ids.
  function BatchIndices(j: Journal, limit: nat): seq<nat> {
    var order := SendOrder(j);
    order[..Min(limit, |order|)]
  }

  function NextBatch(j: Journal, limit: nat): seq<Id>
    requires Valid(j)
  {
    var b := BatchIndices(j, limit);
    HeldOfKindIsHeld(j, Other, 0);
    HeldOfKindIsHeld(j, Score, 0);
    seq(|b|, p requires 0 <= p < |b| => j[b[p]].id)
  }

  ghost function HeldCount(j: Journal): nat { |set a | 0 <= a < |j| && IsHeld(j[a])| }

  // REQ-BATCH-HELD: a cycle sends only held records (an acknowledged one is never resent).
  // REQ-BATCH-LIMIT: at most `limit` of them.
  // REQ-BATCH-FULL: as many as the limit allows: a cycle never leaves a held record behind for no
  //   reason, so a backlog drains (5.5, Backlog).
  // REQ-BATCH-NO-OVERTAKING (J7): if a record is sent, every held record that sends before it is
  //   in the same batch, earlier.
  // REQ-BATCH-ONCE: no record is in a batch twice.
  // REQ-BATCH-IDS: NextBatch is exactly those records' ids, in that order, so every requirement
  //   above holds of what the cycle sends.
  lemma NextBatchRequirements(j: Journal, limit: nat)
    requires Valid(j)
    ensures var b := BatchIndices(j, limit);
      && |NextBatch(j, limit)| == |b|
      && (forall p :: 0 <= p < |b| ==> b[p] < |j| && NextBatch(j, limit)[p] == j[b[p]].id)
      && (forall p :: 0 <= p < |b| ==> b[p] < |j| && IsHeld(j[b[p]]))
      && |b| <= limit
      && |b| == Min(limit, HeldCount(j))
      && (forall p, a :: 0 <= p < |b| && 0 <= a < |j| && a != b[p] && IsHeld(j[a])
            && SendsBefore(j, a, b[p])
            ==> exists q :: 0 <= q < p && b[q] == a)
      && (forall p, q :: 0 <= p < q < |b| ==> b[p] != b[q])
      && (forall p, q :: 0 <= p < q < |b| ==> NextBatch(j, limit)[p] != NextBatch(j, limit)[q])
  {
    var others := HeldOfKind(j, Other, 0);
    var scores := HeldOfKind(j, Score, 0);
    var order := SendOrder(j);
    var b := BatchIndices(j, limit);
    HeldOfKindIsHeld(j, Other, 0);
    HeldOfKindIsHeld(j, Score, 0);
    HeldOfKindIncreasing(j, Other, 0);
    HeldOfKindIncreasing(j, Score, 0);
    HeldOfKindComplete(j, Other, 0);
    HeldOfKindComplete(j, Score, 0);
    SendOrderIsAllHeld(j);

    forall p, a | 0 <= p < |b| && 0 <= a < |j| && a != b[p] && IsHeld(j[a]) && SendsBefore(j, a, b[p])
      ensures exists q :: 0 <= q < p && b[q] == a
    {
      var x := b[p];
      if j[a].kind == Other {
        var qa :| 0 <= qa < |others| && others[qa] == a;
        if j[x].kind == Other {
          var px :| 0 <= px < |others| && others[px] == x;
          assert order[px] == x;
          OrderedIndexUnique(order, p, px, others, scores);
          IncreasingIndexOrder(others, qa, px);
          assert order[qa] == a;
        } else {
          assert p >= |others| by { if p < |others| { assert j[order[p]].kind == Other; } }
          assert order[qa] == a;
        }
        assert b[qa] == a;
      } else {
        assert j[x].kind == Score && a < x;
        var qa :| 0 <= qa < |scores| && scores[qa] == a;
        assert p >= |others| by { if p < |others| { assert j[order[p]].kind == Other; } }
        var px := p - |others|;
        assert scores[px] == x;
        IncreasingIndexOrder(scores, qa, px);
        assert order[|others| + qa] == a;
        assert b[|others| + qa] == a;
      }
    }

    assert forall p, q :: 0 <= p < q < |b| ==> b[p] != b[q] by {
      forall p, q | 0 <= p < q < |b| ensures b[p] != b[q] {
        OrderDistinct(j, p, q);
      }
    }
    var ids := NextBatch(j, limit);
    forall p, q | 0 <= p < q < |b| ensures ids[p] != ids[q] {
      OrderDistinct(j, p, q);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // ApplyReply (5; 7, Answers): mark the records the server acknowledged.

  // The first acknowledging answer the reply gives for `id`. Any acknowledgement naming a record's
  // id acknowledges it (J4). A reply that names one id twice with two different answers is not
  // something the server sends (L3); if it ever did, the first wins, so the operation stays defined.
  function FirstAck(reply: Reply, id: Id): Option<Answer> {
    if |reply| == 0 then None
    else if reply[0].0 == id && reply[0].1.Answered? then Some(reply[0].1.answer)
    else FirstAck(reply[1..], id)
  }

  function ApplyOne(e: Entry, reply: Reply): Entry {
    if IsHeld(e) then
      match FirstAck(reply, e.id)
      case Some(a) => e.(state := Acknowledged(a))
      case None => e
    else e
  }

  function ApplyReply(j: Journal, reply: Reply): Journal {
    seq(|j|, i requires 0 <= i < |j| => ApplyOne(j[i], reply))
  }

  ghost predicate Names(reply: Reply, id: Id) { exists p :: 0 <= p < |reply| && reply[p].0 == id }

  // REQ-APPLY-KEEPS-ORDER: same records, same kinds, same order (J4, J7).
  // REQ-APPLY-ONLY-NAMED (J4): an entry changes only if the reply names its id.
  // The reply's first answer for `id` is at position p: p answers it, and every entry before p that
  // names it says retry_later. Stated over the reply alone, not over FirstAck.
  ghost predicate FirstAnswerAt(reply: Reply, id: Id, p: nat) {
    && p < |reply| && reply[p].0 == id && reply[p].1.Answered?
    && forall q :: 0 <= q < p && reply[q].0 == id ==> reply[q].1 == RetryLater
  }

  // Every entry of the reply that names `id` says retry_later (true too when none names it).
  ghost predicate OnlyRetryLater(reply: Reply, id: Id) {
    forall p :: 0 <= p < |reply| && reply[p].0 == id ==> reply[p].1 == RetryLater
  }

  // REQ-APPLY-ACK (5, states table): a held record the reply answers becomes Acknowledged, keeping
  //   the first answer the reply gives it.
  // REQ-APPLY-RETRY: a held record the reply gives only retry_later, or does not name, stays held.
  // REQ-APPLY-FINAL (J4, D22): an acknowledged record never changes again: not back to held, and
  //   its answer is never rewritten, so a stale reply from an overlapping cycle (5.4) does nothing.
  lemma ApplyReplyRequirements(j: Journal, reply: Reply)
    requires Valid(j)
    ensures var j' := ApplyReply(j, reply);
      && Valid(j')
      && |j'| == |j|
      && (forall i :: 0 <= i < |j| ==> j'[i].id == j[i].id && j'[i].kind == j[i].kind)
      && (forall i :: 0 <= i < |j| && j'[i] != j[i] ==> Names(reply, j[i].id))
      && (forall i, p :: 0 <= i < |j| && 0 <= p && IsHeld(j[i]) && FirstAnswerAt(reply, j[i].id, p)
            ==> j'[i] == j[i].(state := Acknowledged(reply[p].1.answer)))
      && (forall i :: 0 <= i < |j| && IsHeld(j[i]) && OnlyRetryLater(reply, j[i].id)
            ==> j'[i] == j[i])
      && (forall i :: 0 <= i < |j| && !IsHeld(j[i]) ==> j'[i] == j[i])
  {
    var j' := ApplyReply(j, reply);
    forall i | 0 <= i < |j| && j'[i] != j[i] ensures Names(reply, j[i].id) {
      FirstAckNames(reply, j[i].id);
    }
    forall i, p | 0 <= i < |j| && 0 <= p && IsHeld(j[i]) && FirstAnswerAt(reply, j[i].id, p)
      ensures j'[i] == j[i].(state := Acknowledged(reply[p].1.answer))
    {
      FirstAckAt(reply, j[i].id, p);
    }
    forall i | 0 <= i < |j| && IsHeld(j[i]) && OnlyRetryLater(reply, j[i].id) ensures j'[i] == j[i] {
      FirstAckNoneWhenOnlyRetry(reply, j[i].id);
    }
  }

  // REQ-APPLY-IDEMPOTENT (the device's half of L3): the same reply applied twice, as when two
  // overlapping cycles get the same answers, changes nothing more than applying it once.
  lemma ApplyReplyIdempotent(j: Journal, reply: Reply)
    ensures ApplyReply(ApplyReply(j, reply), reply) == ApplyReply(j, reply)
  {}

  // Replies agree when every answer either gives a record is the same, which the server always
  // does: a repeat gets the answer stored the first time (L3).
  ghost predicate Agree(r1: Reply, r2: Reply) {
    forall p, q ::
      (0 <= p < |r1| && 0 <= q < |r2| && r1[p].0 == r2[q].0 && r1[p].1.Answered? && r2[q].1.Answered?)
      ==> r1[p].1 == r2[q].1
  }

  // REQ-APPLY-ANY-ORDER (5.4, overlapping cycles): two cycles' replies give the same journal
  // whichever is applied first.
  lemma ApplyReplyCommutes(j: Journal, r1: Reply, r2: Reply)
    requires Agree(r1, r2)
    ensures ApplyReply(ApplyReply(j, r1), r2) == ApplyReply(ApplyReply(j, r2), r1)
  {
    forall id | FirstAck(r1, id).Some? && FirstAck(r2, id).Some?
      ensures FirstAck(r1, id) == FirstAck(r2, id)
    {
      var p := FirstAckFrom(r1, id);
      var q := FirstAckFrom(r2, id);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Consistency: one journal where every requirement holds at once, with a record of each kind and
  // each state, and a reply that acknowledges one, asks another to retry and skips a third.

  lemma RequirementsAreConsistent()
    ensures var j := [Entry(1, Other, Acknowledged(Holds)), Entry(2, Score, Held),
                      Entry(3, Other, Held), Entry(4, Other, Held)];
      && Valid(j)
      && NextBatch(j, 2) == [3, 4]
      && NextBatch(j, 9) == [3, 4, 2]
      && ApplyReply(j, [(3, Answered(Applied)), (4, RetryLater), (1, Answered(Refused(2)))])
         == [Entry(1, Other, Acknowledged(Holds)), Entry(2, Score, Held),
             Entry(3, Other, Acknowledged(Applied)), Entry(4, Other, Held)]
  {
    var j := [Entry(1, Other, Acknowledged(Holds)), Entry(2, Score, Held),
              Entry(3, Other, Held), Entry(4, Other, Held)];
    assert HeldOfKind(j, Other, 0) == [2, 3];
    assert HeldOfKind(j, Score, 0) == [1];
  }

  // ---------------------------------------------------------------------------------------------
  // Proof helpers

  lemma HeldOfKindIsHeld(j: Journal, k: Kind, from: nat)
    requires from <= |j|
    ensures forall p :: 0 <= p < |HeldOfKind(j, k, from)| ==>
      from <= HeldOfKind(j, k, from)[p] < |j|
      && IsHeld(j[HeldOfKind(j, k, from)[p]])
      && j[HeldOfKind(j, k, from)[p]].kind == k
    decreases |j| - from
  {
    if from < |j| { HeldOfKindIsHeld(j, k, from + 1); }
  }

  ghost predicate Increasing(s: seq<nat>) { forall p, q :: 0 <= p < q < |s| ==> s[p] < s[q] }

  lemma HeldOfKindIncreasing(j: Journal, k: Kind, from: nat)
    requires from <= |j|
    ensures Increasing(HeldOfKind(j, k, from))
    decreases |j| - from
  {
    if from < |j| {
      HeldOfKindIncreasing(j, k, from + 1);
      HeldOfKindIsHeld(j, k, from + 1);
    }
  }

  lemma HeldOfKindComplete(j: Journal, k: Kind, from: nat)
    requires from <= |j|
    ensures forall a :: from <= a < |j| && IsHeld(j[a]) && j[a].kind == k ==> a in HeldOfKind(j, k, from)
    decreases |j| - from
  {
    if from < |j| { HeldOfKindComplete(j, k, from + 1); }
  }

  lemma IncreasingIndexOrder(s: seq<nat>, p: nat, q: nat)
    requires Increasing(s) && p < |s| && q < |s|
    requires s[p] < s[q]
    ensures p < q
  {
    if p >= q { if p > q { assert s[q] < s[p]; } }
  }

  lemma OrderedIndexUnique(order: seq<nat>, p: nat, px: nat, others: seq<nat>, scores: seq<nat>)
    requires order == others + scores
    requires Increasing(others)
    requires px < |others| && p < |order|
    requires order[p] == order[px]
    requires forall a, b :: 0 <= a < |others| && 0 <= b < |scores| ==> others[a] != scores[b]
    ensures p == px
  {
    if p < |others| {
      if p != px { if p < px { assert others[p] < others[px]; } else { assert others[px] < others[p]; } }
    } else {
      assert scores[p - |others|] == others[px];
    }
  }

  lemma SendOrderIsAllHeld(j: Journal)
    ensures |SendOrder(j)| == HeldCount(j)
    ensures forall a, b :: 0 <= a < |HeldOfKind(j, Other, 0)| && 0 <= b < |HeldOfKind(j, Score, 0)| ==>
      HeldOfKind(j, Other, 0)[a] != HeldOfKind(j, Score, 0)[b]
  {
    var others := HeldOfKind(j, Other, 0);
    var scores := HeldOfKind(j, Score, 0);
    HeldOfKindIsHeld(j, Other, 0);
    HeldOfKindIsHeld(j, Score, 0);
    HeldOfKindIncreasing(j, Other, 0);
    HeldOfKindIncreasing(j, Score, 0);
    HeldOfKindComplete(j, Other, 0);
    HeldOfKindComplete(j, Score, 0);
    var order := SendOrder(j);
    var heldSet := set a | 0 <= a < |j| && IsHeld(j[a]);
    var orderSet := set p | 0 <= p < |order| :: order[p];
    assert orderSet == heldSet by {
      forall a | a in heldSet ensures a in orderSet {
        if j[a].kind == Other {
          var p :| 0 <= p < |others| && others[p] == a;
          assert order[p] == a;
        } else {
          var p :| 0 <= p < |scores| && scores[p] == a;
          assert order[|others| + p] == a;
        }
      }
    }
    forall p, q | 0 <= p < q < |order| ensures order[p] != order[q] {
      if q < |others| {
        assert others[p] < others[q];
      } else if p >= |others| {
        assert scores[p - |others|] < scores[q - |others|];
      } else {
        assert j[order[p]].kind == Other && j[order[q]].kind == Score;
      }
    }
    DistinctSeqCard(order);
  }

  lemma DistinctSeqCard(s: seq<nat>)
    requires forall p, q :: 0 <= p < q < |s| ==> s[p] != s[q]
    ensures |set p | 0 <= p < |s| :: s[p]| == |s|
  {
    if |s| > 0 {
      var t := s[..|s| - 1];
      DistinctSeqCard(t);
      var st := set p | 0 <= p < |t| :: t[p];
      var ss := set p | 0 <= p < |s| :: s[p];
      assert ss == st + {s[|s| - 1]};
      assert s[|s| - 1] !in st;
    }
  }

  lemma OrderDistinct(j: Journal, p: nat, q: nat)
    requires Valid(j)
    requires p < q < |SendOrder(j)|
    ensures SendOrder(j)[p] != SendOrder(j)[q]
    ensures SendOrder(j)[p] < |j| && SendOrder(j)[q] < |j|
    ensures j[SendOrder(j)[p]].id != j[SendOrder(j)[q]].id
  {
    var others := HeldOfKind(j, Other, 0);
    var scores := HeldOfKind(j, Score, 0);
    var order := SendOrder(j);
    HeldOfKindIsHeld(j, Other, 0);
    HeldOfKindIsHeld(j, Score, 0);
    HeldOfKindIncreasing(j, Other, 0);
    HeldOfKindIncreasing(j, Score, 0);
    if q < |others| {
      assert others[p] < others[q];
    } else if p >= |others| {
      assert scores[p - |others|] < scores[q - |others|];
    } else {
      assert j[order[p]].kind == Other && j[order[q]].kind == Score;
    }
  }

  lemma FirstAckAt(reply: Reply, id: Id, p: nat)
    requires FirstAnswerAt(reply, id, p)
    ensures FirstAck(reply, id) == Some(reply[p].1.answer)
  {
    if p > 0 {
      assert reply[0].0 == id ==> reply[0].1 == RetryLater;
      assert forall q :: 0 <= q < |reply[1..]| ==> reply[1..][q] == reply[q + 1];
      FirstAckAt(reply[1..], id, p - 1);
    }
  }

  lemma FirstAckNoneWhenOnlyRetry(reply: Reply, id: Id)
    requires OnlyRetryLater(reply, id)
    ensures FirstAck(reply, id).None?
  {
    if |reply| > 0 {
      assert forall p :: 0 <= p < |reply[1..]| ==> reply[1..][p] == reply[p + 1];
      FirstAckNoneWhenOnlyRetry(reply[1..], id);
    }
  }

  // FirstAck's answer comes from an entry of the reply.
  lemma FirstAckFrom(reply: Reply, id: Id) returns (p: nat)
    requires FirstAck(reply, id).Some?
    ensures p < |reply| && reply[p] == (id, Answered(FirstAck(reply, id).value))
  {
    if reply[0].0 == id && reply[0].1.Answered? {
      p := 0;
    } else {
      var p' := FirstAckFrom(reply[1..], id);
      p := p' + 1;
    }
  }

  lemma FirstAckNames(reply: Reply, id: Id)
    ensures FirstAck(reply, id).Some? ==> Names(reply, id)
  {
    if |reply| > 0 && !(reply[0].0 == id && reply[0].1.Answered?) {
      FirstAckNames(reply[1..], id);
      if FirstAck(reply[1..], id).Some? {
        var p :| 0 <= p < |reply[1..]| && reply[1..][p].0 == id;
        assert reply[p + 1].0 == id;
      }
    }
  }
}

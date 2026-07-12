import { within } from '@/test/utilities'

import { headToHeadCardDisplayPage } from './head-to-head-card-display.page'
import {
  buildFrequentOpponentView,
  buildHeadToHeadView,
  buildNeverMetRecordView,
  buildOwnProfileHeadToHeadView,
  buildViewerRecordView,
} from './head-to-head-card-display.factory'

describe('HeadToHeadCardDisplay', () => {
  describe('somebody else’s profile — it leads with YOUR record', () => {
    it('says the record from the VIEWER’s side, not the player’s', async () => {
      // The fixture is 1–4 and lopsided on purpose. `A 4–1 B` and `B 1–4 A` are
      // the same head-to-head said two ways (CONTEXT.md), so a card that read it
      // from the player's side would print "4–1" here — and a symmetric 2–2
      // fixture could not tell the two apart.
      headToHeadCardDisplayPage.render({
        headToHead: buildHeadToHeadView({
          playerName: 'perky-ringtail',
          versusViewer: buildViewerRecordView({
            record: '1–4',
            opponent: { id: 'p-1', username: 'perky-ringtail' },
          }),
        }),
      })

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(headToHeadCardDisplayPage.queryVersusRecord()).toHaveTextContent(
        '1–4',
      )
      expect(headToHeadCardDisplayPage.queryVersusRecord()).not.toHaveTextContent(
        '4–1',
      )
      // …and it is addressed to the viewer, in the second person.
      expect(headToHeadCardDisplayPage.queryVersusLine()).toHaveTextContent(
        'You’re 1–4 against perky-ringtail',
      )
    })

    it('names the card "Head-to-head" and shows the meetings and when they last met', async () => {
      headToHeadCardDisplayPage.render()

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(headToHeadCardDisplayPage.getHeadToHeadTitle()).toBe('Head-to-head')
      expect(headToHeadCardDisplayPage.queryVersusMeta()).toHaveTextContent(
        '5 meetings',
      )
      expect(headToHeadCardDisplayPage.queryVersusMeta()).toHaveTextContent(
        'Last met Mar 14, 2025',
      )
    })

    it('keeps their frequent opponents BELOW your record, as secondary context', async () => {
      // They stay on the card — but named as *theirs*, so the two records on
      // screen can't be misread as one. The lead is yours; this list is not.
      headToHeadCardDisplayPage.render()

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(headToHeadCardDisplayPage.queryFrequentTitle()).toHaveTextContent(
        'perky-ringtail’s frequent opponents',
      )
      expect(headToHeadCardDisplayPage.getFrequentOpponentNames()).toEqual([
        'nia.brandt',
        'omar.faye',
        'sable.rook',
      ])
      // The rows are the PLAYER's record against each — 6–2, not the viewer's.
      expect(headToHeadCardDisplayPage.getFrequentRecord('nia.brandt')).toBe('6–2')
    })

    it('offers no Start-a-match CTA to somebody you have already played', async () => {
      // The CTA belongs to the never-met state. Here there is a record to read,
      // and a "start a match" button under it would be an odd thing to say to
      // someone who has played them five times.
      headToHeadCardDisplayPage.render()

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(headToHeadCardDisplayPage.queryStartMatchLink()).toBeNull()
    })
  })

  describe('never met — the invitation, not a 0–0', () => {
    it('invites you to play them instead of printing an empty record', async () => {
      // The common case, not an edge one: a guest session is minted for anyone who
      // lands on a profile link, and a guest has played nobody (ADR-0915). A
      // "You're 0–0 against perky-ringtail" here would be technically true and
      // completely useless.
      headToHeadCardDisplayPage.render({
        headToHead: buildHeadToHeadView({
          playerName: 'perky-ringtail',
          versusViewer: buildNeverMetRecordView({
            opponent: { id: 'p-1', username: 'perky-ringtail' },
          }),
        }),
      })

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(headToHeadCardDisplayPage.queryInvite()).toHaveTextContent(
        'You haven’t played perky-ringtail yet.',
      )
      // Not a record, and specifically not a zero one.
      expect(headToHeadCardDisplayPage.queryVersusLine()).toBeNull()
      expect(
        headToHeadCardDisplayPage.getHeadToHeadCard(),
      ).not.toHaveTextContent('0–0')
    })

    it('offers Start a match, and arrives at match creation with THEM already picked', async () => {
      // The app's best conversion moment. The CTA carries the player in
      // `?opponent=`, which the match-creation route parses at its boundary (chore
      // 7c) and uses to preseed the picker — so the CTA is one click from a match,
      // not a click into a search box.
      headToHeadCardDisplayPage.render({
        headToHead: buildHeadToHeadView({
          versusViewer: buildNeverMetRecordView({
            opponent: { id: 'p-42', username: 'perky-ringtail' },
          }),
        }),
      })

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(headToHeadCardDisplayPage.queryStartMatchLink()).toBeInTheDocument()
      expect(headToHeadCardDisplayPage.getStartMatchHref()).toBe(
        '/matches/new?opponent=p-42',
      )
    })
  })

  describe('your own profile — no self-record, no self-challenge', () => {
    it('is just "Frequent opponents": no record against yourself', async () => {
      headToHeadCardDisplayPage.render({
        headToHead: buildOwnProfileHeadToHeadView(),
      })

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(headToHeadCardDisplayPage.getHeadToHeadTitle()).toBe(
        'Frequent opponents',
      )
      expect(headToHeadCardDisplayPage.queryVersusLine()).toBeNull()
      expect(headToHeadCardDisplayPage.queryInvite()).toBeNull()
      // The list is unqualified here — they are *your* opponents, and the heading
      // already said so.
      expect(headToHeadCardDisplayPage.queryFrequentTitle()).toBeNull()
      expect(headToHeadCardDisplayPage.getFrequentOpponentNames()).toEqual([
        'nia.brandt',
        'omar.faye',
        'sable.rook',
      ])
    })

    it('never offers a match against YOURSELF', async () => {
      // The self-profile is the edge case to remember when adding any card
      // (ADR-0915). Here it is the whole point: you cannot play yourself, so the
      // card's one action must not exist.
      headToHeadCardDisplayPage.render({
        headToHead: buildOwnProfileHeadToHeadView(),
      })

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(headToHeadCardDisplayPage.queryStartMatchLink()).toBeNull()
      expect(
        headToHeadCardDisplayPage.getHeadToHeadCard(),
      ).not.toHaveTextContent(/start a match/i)
    })
  })

  describe('the frequent-opponent names are links to those players', () => {
    it('sends each name to THAT opponent’s profile, not to the profiled player’s', async () => {
      // The card would tell you the player was 1–1 against sable.rook and then
      // give you nowhere to click — a dead end on the page whose job is to be a
      // hub. The id was in the view all along (it is the row's React `key`).
      //
      // Asserted per row, on the href, because the two bugs a bare "there is a
      // link" check waves through are exactly the plausible ones: every row
      // linking to the *profiled* player (p-1, the id sitting right there in
      // `versusViewer`), or every row linking to the first opponent.
      headToHeadCardDisplayPage.render({
        headToHead: buildHeadToHeadView({
          playerName: 'perky-ringtail',
          versusViewer: buildViewerRecordView({
            opponent: { id: 'p-1', username: 'perky-ringtail' },
          }),
        }),
      })

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(
        headToHeadCardDisplayPage.getFrequentOpponentHref('nia.brandt'),
      ).toBe('/players/p-21')
      expect(
        headToHeadCardDisplayPage.getFrequentOpponentHref('omar.faye'),
      ).toBe('/players/p-22')
      expect(
        headToHeadCardDisplayPage.getFrequentOpponentHref('sable.rook'),
      ).toBe('/players/p-23')
      // Row order, and one link per row — no row left as plain text, and none of
      // them pointing at the player whose profile this is.
      expect(headToHeadCardDisplayPage.getFrequentOpponentHrefs()).toEqual([
        '/players/p-21',
        '/players/p-22',
        '/players/p-23',
      ])
    })

    it('links them on your own profile too — your rivals are just as reachable', async () => {
      headToHeadCardDisplayPage.render({
        headToHead: buildOwnProfileHeadToHeadView({
          frequentOpponents: [
            buildFrequentOpponentView({ id: 'p-77', username: 'nia.brandt' }),
          ],
        }),
      })

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(
        headToHeadCardDisplayPage.getFrequentOpponentHref('nia.brandt'),
      ).toBe('/players/p-77')
    })

    it('keeps the row’s record, meetings and decorative bar exactly as they were', async () => {
      // Only the NAME became a link. The bar stays aria-hidden (it says the
      // record a second time, geometrically), so the row must still expose
      // exactly one link — a bar or a record turned linky would be a regression
      // that "the name is a link" alone would not notice.
      headToHeadCardDisplayPage.render({
        headToHead: buildHeadToHeadView({
          frequentOpponents: [
            buildFrequentOpponentView({
              id: 'p-21',
              username: 'nia.brandt',
              record: '6–2',
              meetings: '8 meetings',
              winShare: 0.75,
            }),
          ],
        }),
      })

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      const [row] = headToHeadCardDisplayPage.getFrequentRows()
      expect(within(row).getAllByRole('link')).toHaveLength(1)
      expect(headToHeadCardDisplayPage.getFrequentRecord('nia.brandt')).toBe(
        '6–2',
      )
      expect(row).toHaveTextContent('8 meetings')
      expect(headToHeadCardDisplayPage.getFrequentBarWidth('nia.brandt')).toBe(
        '75%',
      )
    })
  })

  describe('the win-share bars', () => {
    it('draws each bar at the share of meetings the player WON', async () => {
      headToHeadCardDisplayPage.render({
        headToHead: buildHeadToHeadView({
          frequentOpponents: [
            buildFrequentOpponentView({
              username: 'nia.brandt',
              record: '6–2',
              winShare: 0.75,
            }),
          ],
        }),
      })

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(headToHeadCardDisplayPage.getFrequentBarWidth('nia.brandt')).toBe(
        '75%',
      )
    })
  })

  describe('nobody met at all', () => {
    it('says so rather than rendering an empty list, in the right person', async () => {
      headToHeadCardDisplayPage.render({
        headToHead: buildOwnProfileHeadToHeadView({ frequentOpponents: [] }),
      })

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(headToHeadCardDisplayPage.queryFrequentEmpty()).toHaveTextContent(
        'You haven’t played anyone yet.',
      )
      expect(headToHeadCardDisplayPage.getFrequentRows()).toHaveLength(0)
    })

    it('speaks in the THIRD person about somebody else with no opponents', async () => {
      headToHeadCardDisplayPage.render({
        headToHead: buildHeadToHeadView({
          playerName: 'perky-ringtail',
          frequentOpponents: [],
        }),
      })

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(headToHeadCardDisplayPage.queryFrequentEmpty()).toHaveTextContent(
        'perky-ringtail hasn’t played anyone yet.',
      )
    })

    it('keeps the "X’s frequent opponents" sub-heading over somebody else’s empty list', async () => {
      // The empty line is a *section that happens to be empty*, not a stray
      // sentence. Without its sub-heading it lands directly under the card's
      // HEAD-TO-HEAD heading — and, in the never-met state, directly under "You
      // haven't played X yet.", where "X hasn't played anyone yet." reads as a
      // contradiction of the line above rather than as a second, quieter section
      // about them.
      headToHeadCardDisplayPage.render({
        headToHead: buildHeadToHeadView({
          playerName: 'perky-ringtail',
          frequentOpponents: [],
        }),
      })

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(headToHeadCardDisplayPage.queryFrequentTitle()).toHaveTextContent(
        'perky-ringtail’s frequent opponents',
      )
      // …and the empty line sits INSIDE that labelled block, rather than beside
      // it — which is the shape the early-return used to produce.
      expect(headToHeadCardDisplayPage.queryFrequentBlock()).toContainElement(
        headToHeadCardDisplayPage.queryFrequentEmpty() as HTMLElement,
      )
    })

    it('still gives your OWN empty list no sub-heading — the card’s heading already says it', async () => {
      // The other half of the pair above, and the reason this is not simply
      // "always render the sub-heading": on your own profile the card's <h2>
      // already reads "Frequent opponents", so a sub-heading would only repeat
      // it. Empty changes nothing about that.
      headToHeadCardDisplayPage.render({
        headToHead: buildOwnProfileHeadToHeadView({ frequentOpponents: [] }),
      })

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(headToHeadCardDisplayPage.getHeadToHeadTitle()).toBe(
        'Frequent opponents',
      )
      expect(headToHeadCardDisplayPage.queryFrequentTitle()).toBeNull()
      expect(
        headToHeadCardDisplayPage.getHeadToHeadCard(),
      ).not.toHaveTextContent(/’s frequent opponents/i)
    })

    it('labels the empty section even in the never-met dead end, below the Start-a-match CTA', async () => {
      // The demo case, and the one that produced the bug report: a player nobody
      // has played, viewed by somebody who has not played them either — which is
      // every guest arriving on a shared link. Both empty states are on screen at
      // once, and each must be legible as its own thing.
      headToHeadCardDisplayPage.render({
        headToHead: buildHeadToHeadView({
          playerName: 'perky-ringtail',
          versusViewer: buildNeverMetRecordView({
            opponent: { id: 'p-1', username: 'perky-ringtail' },
          }),
          frequentOpponents: [],
        }),
      })

      await headToHeadCardDisplayPage.findHeadToHeadCard()

      expect(headToHeadCardDisplayPage.queryInvite()).toHaveTextContent(
        'You haven’t played perky-ringtail yet.',
      )
      expect(headToHeadCardDisplayPage.queryStartMatchLink()).toBeInTheDocument()
      expect(headToHeadCardDisplayPage.queryFrequentTitle()).toHaveTextContent(
        'perky-ringtail’s frequent opponents',
      )
      expect(headToHeadCardDisplayPage.queryFrequentEmpty()).toHaveTextContent(
        'perky-ringtail hasn’t played anyone yet.',
      )
      expect(headToHeadCardDisplayPage.queryFrequentBlock()).toContainElement(
        headToHeadCardDisplayPage.queryFrequentEmpty() as HTMLElement,
      )
    })
  })
})

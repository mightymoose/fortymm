import { Link, useSearch } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { GateGallery } from './GateGallery'
import { Gate2Flow, type FlowStart } from './Gate2Flow'
import {
  badger,
  heron,
  hummingbird,
  LATENCY,
  mainPlayer,
  managedPlayers,
  mellow,
  PAGE,
  type ManagedPlayer,
  type Scenario,
  type SourcePlayer,
} from './gate2Data'
import './loginGate2.css'

const koala = managedPlayers[0]

const longManaged: readonly ManagedPlayer[] = [
  { id: 'hedgehog', name: 'harmonious hedgehog 731', total: 27, lastMatch: 'Oluwaseun Adeyemi-Fitzgerald on Oct 22' },
  { id: 'kingfisher', name: 'knightly kingfisher 641', total: 3, lastMatch: 'Maximiliane Hohenberger on Jun 14' },
]

function one(
  player: SourcePlayer,
  { main = mainPlayer, managed = [], ...rest }: { main?: string | null; managed?: readonly ManagedPlayer[] } & Omit<
    Scenario,
    'account' | 'queue'
  > = {},
): Scenario {
  return { account: { main, managed }, queue: [player], ...rest }
}

const badgerManaged: ManagedPlayer = { id: badger.id, name: badger.name, total: 12, lastMatch: 'Lin Wei on Oct 27' }

function two(managed: readonly ManagedPlayer[] = [], rest: Omit<Scenario, 'account' | 'queue'> = {}): Scenario {
  return { account: { main: mainPlayer, managed }, queue: [badger, mellow], ...rest }
}

type Gate2Frame = { title: string; slug: string; render: (fullScreen: boolean) => ReactNode }

// The frame's title as a URL word, such as `which-player-nothing-chosen`.
function slugOf(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function frame(title: string, scenario: Scenario, start?: FlowStart, hold?: boolean): Gate2Frame {
  return {
    title,
    slug: slugOf(title),
    render: (fullScreen) => <Gate2Flow scenario={scenario} start={start} hold={hold} fullScreen={fullScreen} />,
  }
}

const frames: readonly Gate2Frame[] = [
  frame('Yes merges into your main player', one(mellow)),
  frame('Yes with no main player yet', one(mellow, { main: null })),
  frame('A larger history, whose third page fails once', one(heron, { failPage: 2 })),
  frame('History, the first page loading (held)', one(heron), { view: 'history', history: { pages: 0, loading: true } }, true),
  frame('History, a page failed, with Retry', one(heron), { view: 'history', history: { pages: 1, failed: true } }),
  frame('History, every match loaded', one(heron), { view: 'history', history: { pages: 3 } }),
  frame('Someone else played, no managed players', one(mellow), { view: 'manage' }),
  frame('Someone else played, with managed players', one(mellow, { managed: managedPlayers }), { view: 'manage' }),
  frame('Which of your players?', one(mellow, { managed: managedPlayers }), { view: 'pick' }),
  frame('Saving Yes (held)', one(mellow), { saving: { kind: 'yes' } }, true),
  frame(
    'Saving kindly koala 552 (held)',
    one(mellow, { managed: managedPlayers }),
    { view: 'pick', saving: { kind: 'merge', into: koala } },
    true,
  ),
  frame('Error on Yes', one(mellow), { failed: { kind: 'yes' } }),
  frame('Error on Someone I manage', one(mellow), { view: 'manage', failed: { kind: 'separate' } }),
  frame('Error on kindly koala 552', one(mellow, { managed: managedPlayers }), {
    view: 'pick',
    failed: { kind: 'merge', into: koala },
  }),
  frame('Long player names', one(hummingbird, { main: 'marvelous mongoose 902' })),
  frame('Long player names, Which of your players?', one(hummingbird, { managed: longManaged }), { view: 'pick' }),
  frame('Done after Yes', one(mellow), { done: { player: mainPlayer, message: `3 matches added to ${mainPlayer}.` } }),
  frame('Done after kindly koala 552', one(mellow), {
    done: { player: mainPlayer, message: `3 matches added to ${koala.name}.` },
  }),
  frame('Done after Someone I manage', one(mellow), {
    done: { player: mainPlayer, message: `You manage ${mellow.name} now.` },
  }),
  frame('Done after Not someone I know', one(mellow), {
    done: { player: mainPlayer, message: `${mellow.name} removed from your account.` },
  }),
  frame('Two players: player 1 of 2', two()),
  frame('Two players: Which of your players? stays on player 1', two(managedPlayers), { view: 'pick' }),
  frame('Two players: player 2 of 2 after the first answer', two([badgerManaged]), {
    index: 1,
    notice: `You manage ${badger.name} now.`,
  }),
  frame('Two players: the first save fails once', two([], { failFirstSave: true })),
  frame('Two players: done after the last answer', two(), {
    index: 1,
    done: { player: mainPlayer, message: `3 matches added to ${mainPlayer}.` },
  }),
]

// Layout 2, activity first: one centred column that leads with the matches,
// and asks about one player at a time. `?frame=` shows one frame full
// screen, at the window's real size.
export function LoginGate2() {
  const { frame: slug } = useSearch({ from: '/login-gate2' })
  const alone = slug && frames.find((found) => found.slug === slug)
  if (alone) return <div className="g2-screen">{alone.render(true)}</div>
  return (
    <GateGallery
      current="/login-gate2"
      description="One column that leads with the matches, because people recognize their matches, not a random name. It asks about one player at a time."
      frames={frames.map((found) => ({ title: found.title, render: () => found.render(false) }))}
      frameLink={(title) => (
        <Link className="g2-open" to="/login-gate2" search={{ frame: slugOf(title) }}>
          Open full screen
        </Link>
      )}
    >
      <Requirements />
    </GateGallery>
  )
}

function Requirements() {
  return (
    <section className="g2-reqs" aria-labelledby="g2-reqs-title">
      <h2 id="g2-reqs-title">Simulated here, and what the real gate needs</h2>

      <h3>On this page</h3>
      <ul>
        <li>
          Every frame works. It starts at the state its title names. A save takes {LATENCY / 1000} s and then moves
          to the next player or to the dashboard. A frame marked “held” never finishes its request.
        </li>
        <li>
          The data and the API are simulated in <code>gate2Data.ts</code>. The history view fetches {PAGE} matches a
          page from the simulated server as the end of the list comes near. Some frames fail one save or one page
          once, to show the error and the retry.
        </li>
        <li>
          Each frame here is a box that scrolls. On a phone, the box doesn’t fit the screen, so use “Open full
          screen”: it shows the frame at the window’s real size, and the page scrolls as in the real gate.
        </li>
      </ul>

      <h3>The real gate</h3>
      <ul>
        <li>
          It reads the open questions from <code>GET /v1/account/players</code>, not from <code>signed_in=1</code>.{' '}
          <code>AuthenticatedLayout</code> checks for any player with <code>open_question</code>, so a reload or a
          direct link to an authenticated page reaches the gate. The loading screen stays up until the check answers.
        </li>
        <li>
          It asks about one player at a time, oldest question first, with the player id as tie-breaker. The player
          on screen stays when a new question arrives. Follow-up steps and the history view are the same question,
          so they don’t move the counter.
        </li>
        <li>
          The counter shows only with more than one player. Its total is the questions answered in this review
          plus the questions still open, so “Player 1 of 1” never shows after an answer.
        </li>
        <li>
          After each saved answer, and when the tab gets focus again, it fetches the list. If another browser
          answered the question first, it sends nothing for that player and moves on. When none is left, it shows
          the page the person asked for, with a toast and no Undo.
        </li>
        <li>
          It sends one answer at a time. The tapped button shows Saving…, and the other actions are off. A failed
          save shows one alert, and the same button tries again with the same choice.
        </li>
        <li>
          The actions sit in a bar at the bottom of the screen, with the safe-area inset under them, and the page
          scrolls above it. Below 480px of height, the bar scrolls with the page, so it can’t cover the content.
        </li>
        <li>
          After an answer, a status notice confirms it and names the next player for screen readers. Focus goes to
          the next heading. Back from the history view puts focus on “View all”, and the history opens again at the
          same place.
        </li>
        <li>The gate only hides pages. The API’s authorization stays as it is.</li>
      </ul>

      <h3>Backend changes</h3>
      <ul>
        <li>
          <code>merge_into_self()</code> keeps the player created first. Yes must always keep the account’s self
          player, with its id and name, and set <code>merged_into</code> on the question’s player. Its tests in{' '}
          <code>tests/services/</code> change with it.
        </li>
        <li>
          <code>start_session()</code> gives every account a self player, even one whose questions are still open.
          So a first sign-in’s Yes would merge into a new player with a random name. Instead, an account with an
          open question gets no new self player, and Yes makes the question’s player <code>self</code>. Then the
          session’s <code>account.player</code> can be null, which breaks <code>/v1</code> and needs a line in{' '}
          <code>openapi-breaking-ignore.txt</code>. If no answer gives the account a player, the session makes one
          after the last answer.
        </li>
        <li>
          A new answer merges the question’s player into a managed player, such as{' '}
          <code>{'{"answer": "no", "merge_into": "<player id>"}'}</code>. The destination keeps its id and name. It
          must be a player that the account manages, that isn’t merged, has no open question and isn’t the
          question’s player. Any other destination answers 409.
        </li>
        <li>
          Each question needs its time, for the order. Each player needs its match count and the dates of its first
          and last match, for the question and the picker.
        </li>
        <li>
          Matches don’t exist in the API yet. The history view needs a paged list of a player’s matches, newest
          first, with stable ids and a cursor. The answer covers every match of the player, so the gate never sends
          match ids.
        </li>
        <li>
          A second <code>yes</code> or <code>no</code> succeeds today and changes nothing. The gate can’t tell that
          another browser answered first. Any answer to an answered question should answer 409.
        </li>
      </ul>
    </section>
  )
}

import { useId } from 'react'
import { Link } from '@tanstack/react-router'
import { Swords } from 'lucide-react'

import type {
  FrequentOpponentView,
  HeadToHeadView,
  ViewerRecordView,
} from './head-to-head-card-query'

export interface HeadToHeadCardDisplayProps {
  headToHead: HeadToHeadView
}

/**
 * The profile's **Head-to-head** card — the page's most viewer-aware surface, and
 * the one card that is genuinely *two different cards* (ADR-0915).
 *
 * On **someone else's** profile it leads with **your** record against them:
 * "You're 1–4 against perky-ringtail". A head-to-head is only meaningful read from
 * a stated side (`CONTEXT.md` § *Head-to-head*) — "perky-ringtail is 2–2 against
 * swift-lynx" answers a question nobody asked. Their frequent opponents stay
 * below it, as secondary context.
 *
 * If you have **never played them** — zero meetings, which is what every *guest*
 * has, and a guest is who lands on a shared profile link — it degrades to a quiet
 * invitation and a **Start a match** CTA prefilled with them. That is not an
 * afterthought state: it is the first thing a brand-new visitor sees, and the
 * app's best conversion moment.
 *
 * On **your own** profile there is no record and no challenge — you cannot play
 * yourself — so the card is just "Frequent opponents".
 *
 * Which of the two it is comes from the **payload** (`versusViewer == null` means
 * the API withheld the block, which it does exactly when the caller is the
 * player), never from the session. See `head-to-head-card-query.ts`.
 *
 * Pure view-in, DOM-out: every record, count and date arrives pre-formatted.
 */
export const HeadToHeadCardDisplay = ({
  headToHead,
}: HeadToHeadCardDisplayProps) => {
  const id = useId()
  const { versusViewer, frequentOpponents, playerName } = headToHead
  const isOwnProfile = versusViewer == null

  return (
    <section
      className="player-profile__section head-to-head"
      aria-labelledby={id}
    >
      <div className="player-profile__section-header">
        {/* The heading itself turns with the viewer: your own profile has no
         * head-to-head on it to be about. */}
        <h2 className="player-profile__section-title" id={id}>
          {isOwnProfile ? 'Frequent opponents' : 'Head-to-head'}
        </h2>
      </div>

      <div className="head-to-head__body">
        {versusViewer && <ViewerRecord record={versusViewer} />}

        <FrequentOpponents
          opponents={frequentOpponents}
          playerName={playerName}
          isOwnProfile={isOwnProfile}
        />
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  You vs them — the lead                                            */
/* ------------------------------------------------------------------ */

/** The viewer's own record against the profiled player, or — when they have never
 * met — the invitation to go and make one. */
const ViewerRecord = ({ record }: { record: ViewerRecordView }) => {
  if (record.neverMet) {
    return (
      <div className="head-to-head__invite">
        <p className="head-to-head__invite-copy">
          You haven’t played {record.opponent.username} yet.
        </p>
        <Link
          to="/matches/new"
          // The opponent search param the match-creation route parses at its
          // boundary: the picker arrives with this player already chosen, so the
          // CTA is one click from a match rather than a search box.
          search={{ opponent: record.opponent.id }}
          className="head-to-head__cta"
        >
          <Swords size={15} strokeWidth={2.5} aria-hidden="true" />
          Start a match
        </Link>
      </div>
    )
  }

  return (
    <div className="head-to-head__versus">
      <p className="head-to-head__versus-line">
        {/* Second person, and the viewer's wins first — this is *your* record,
         * which is the only reason anyone opened this card. */}
        You’re{' '}
        <b className="head-to-head__versus-record">{record.record}</b> against{' '}
        <span className="head-to-head__versus-name">
          {record.opponent.username}
        </span>
      </p>
      <p className="head-to-head__versus-meta">
        {record.meetings}
        {record.lastMeeting && (
          <>
            {' '}
            <span className="head-to-head__dot" aria-hidden="true">
              ·
            </span>{' '}
            {record.lastMeeting}
          </>
        )}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Their frequent opponents — the secondary context                  */
/* ------------------------------------------------------------------ */

const FrequentOpponents = ({
  opponents,
  playerName,
  isOwnProfile,
}: {
  opponents: FrequentOpponentView[]
  playerName: string
  isOwnProfile: boolean
}) => (
  // The empty case is the *same block* as the populated one, deliberately: it
  // used to early-return a bare <p>, which on somebody else's profile left the
  // line "X hasn't played anyone yet." floating unlabelled under HEAD-TO-HEAD —
  // directly beneath "You haven't played X yet.", where it read as a
  // contradiction of it rather than as a second, quieter section. Empty is a
  // designed data state, so it keeps its heading and only loses its rows.
  <div className="head-to-head__frequent">
    {/* On your own profile the card's *heading* already says "Frequent
     * opponents", so a sub-heading repeating it would be noise — full or empty.
     * On somebody else's, the list needs saying whose it is — these are *their*
     * rivalries, not yours, and the block above is the one that is yours. */}
    {!isOwnProfile && (
      <p className="head-to-head__frequent-title">
        {playerName}’s frequent opponents
      </p>
    )}
    {opponents.length === 0 ? (
      <p className="head-to-head__empty">
        {isOwnProfile
          ? 'You haven’t played anyone yet.'
          : `${playerName} hasn’t played anyone yet.`}
      </p>
    ) : (
      <ul className="head-to-head__rows">
        {opponents.map((opponent) => (
          <FrequentOpponentRow key={opponent.id} opponent={opponent} />
        ))}
      </ul>
    )}
  </div>
)

/**
 * One rivalry: their name, the player's record against them, and the win-share
 * bar that says the record again geometrically.
 *
 * The name is a **link to that opponent's profile**. It used to be a bare
 * `<span>`: the card would tell you the player was 1–1 against somebody and then
 * give you no way to go and look at them — a dead end on the page whose whole job
 * is to be a hub. The id it needs was already in the view (it is this row's React
 * `key`), so this costs the query nothing.
 */
const FrequentOpponentRow = ({
  opponent,
}: {
  opponent: FrequentOpponentView
}) => (
  <li className="head-to-head__row">
    <Link
      to="/players/$userId"
      params={{ userId: opponent.id }}
      className="head-to-head__opponent"
    >
      {opponent.username}
    </Link>
    {/* The bar is the record said again, geometrically — so it is decorative, and
     * the record beside it is what a screen reader reads. */}
    <span className="head-to-head__bar" aria-hidden="true">
      <span
        className="head-to-head__bar-fill"
        style={{ width: `${Math.round(opponent.winShare * 100)}%` }}
      />
    </span>
    <span className="head-to-head__record">{opponent.record}</span>
    <span className="head-to-head__meetings">{opponent.meetings}</span>
  </li>
)

// What a refused write says to the person who asked for it — the one shape, shared by
// every tournament surface that reports its own failures **inline** rather than through
// a toast (the draw panel's `drawRefusalNotice`, the header's `lifecycleRefusalNotice`).
//
// It is two halves, and the split is the whole convention:
//
// - the **title** is the CLIENT's — the state, in a few words, in our voice;
// - the **description** is, for the refusals that matter, the **SERVER's own sentence**,
//   verbatim. Those sentences are authored for the director and they name the thing that
//   has to change ("“Open Singles” has no draw yet…", "5 entrants across 3 pools would
//   leave a pool with fewer than 2 entrants…"). Replacing one with a generic string of
//   ours would throw away the only actionable half of the refusal.
//
// That is not a licence to pipe raw API strings into the UI (`DEFINITION_OF_COMPLETE`:
// "raw API detail strings never reach the UI"). It is the opposite: each surface decides,
// per status, whether the server's sentence is *copy* (a 409 the director must act on) or
// *machinery* (a 500's stack-shaped detail), and only the former is shown. The one status
// no surface gets a say in is the 5xx — `fallbackNotice` below refuses to echo it, so the
// FLOOR is safe and a surface that forgets a 5xx arm degrades to words rather than to a
// stack trace.

import { ApiError } from '@/api/client'

/** A refusal in words: a client-owned title, and the sentence beneath it. */
export interface Notice {
  title: string
  description: string
}

/**
 * The last-resort notice for a failure a surface has no designed state for — and the
 * reason no `*RefusalNotice` in this folder has a `null` arm.
 *
 * `verb` completes "Couldn't <verb>" ("cut the draw", "start the tournament"), so the
 * title names the thing the user clicked rather than the wire call that carried it.
 *
 * The three arms are the three *kinds* of nothing-happened:
 * - the request **never got there** at all (a `TypeError` from `fetch`, a dead network,
 *   a CORS refusal). There is no server sentence to show, and pretending otherwise
 *   ("the server rejected the request") would send the user looking for a fault that is
 *   not there;
 * - the server **broke** (a 5xx). It sent a sentence, and we do not show it: a 5xx detail
 *   is machinery, not copy (`DEFINITION_OF_COMPLETE`: "raw API detail strings never reach
 *   the UI"), and it is our fault, not the user's — there is nothing for them to act on.
 *   This arm is why the floor is a floor: a surface may add richer 5xx words of its own
 *   (`lifecycleRefusalNotice` does), but one that *forgets* to still cannot leak a stack
 *   trace into an `AlertDescription`;
 * - the server **said no** (any other `ApiError`) — show its sentence if it sent one,
 *   since an unrecognised 4xx from our own API is still our own copy.
 */
export function fallbackNotice(error: unknown, verb: string): Notice {
  const title = `Couldn't ${verb}`
  if (!(error instanceof ApiError)) {
    return {
      title,
      description: 'The request never reached the server. Check your connection and try again.',
    }
  }
  if (error.status >= 500) {
    return {
      title,
      description: 'Something went wrong on our end. Try again in a moment.',
    }
  }
  return {
    title,
    description: error.detail ?? 'The server rejected the request. Try again in a moment.',
  }
}

import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { NoSigningKey } from '../../api/errors'
import type { GamePoints, Side } from '../../scoring/board'
import { saveBoard } from '../../scoring/boards'
import { queueResult } from '../../scoring/results'
import type { Match } from '../../scoring/demoMatches'
import { draftHash, nowSeconds, replacesOf, resultOf, type Fragment } from '../../scoring/fragment'
import { signWithDeviceKey } from '../../signing/deviceKey'
import { signResult } from '../../signing/envelope'
import { base64url } from '../../signing/text'
import { PATH } from './sides'

export type SubmitResult = ReturnType<typeof useSubmitResult>

// Submit puts the submitted games in the URL as a draft before it signs,
// so a failed signing keeps the deciding score. The pad remounts on that
// save, so its parent holds the mutation and its error. A match that syncs
// queues the signed result for the server, which needs it before it can
// take a correction of it. Nothing waits on that send.
export function useSubmitResult(match: Match, fragment: Fragment, syncs: boolean) {
  const navigate = useNavigate()
  return useMutation({
    networkMode: 'always',
    mutationFn: async ({
      submitted,
      side,
      gameNumber,
    }: {
      submitted: GamePoints[]
      side: Side
      gameNumber: number
    }) => {
      const replaces = await replacesOf(fragment)
      const draft = draftHash(match, submitted, replaces, nowSeconds())
      if (syncs) saveBoard(match.id, draft)
      await navigate({
        to: PATH,
        params: { matchId: match.id, gameNumber: String(gameNumber) },
        search: true,
        hash: draft,
        replace: true,
      })
      const signer = await signWithDeviceKey()
      if (!signer) throw new NoSigningKey()
      return signResult(signer, nowSeconds(), resultOf(match, submitted, replaces), side)
    },
    onSuccess: async (envelope, { gameNumber }) => {
      const hash = base64url(envelope)
      if (syncs) {
        saveBoard(match.id, hash)
        queueResult(match.id, hash)
      }
      // The pad that Back returns to holds the signed result, so a change
      // there corrects it rather than replacing nothing.
      await navigate({
        to: PATH,
        params: { matchId: match.id, gameNumber: String(gameNumber) },
        search: true,
        hash,
        replace: true,
      })
      return navigate({ to: '/matches/$matchId/scores/submission', params: { matchId: match.id }, search: true, hash })
    },
  })
}

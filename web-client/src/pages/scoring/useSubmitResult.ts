import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { NoSigningKey } from '../../api/errors'
import type { GamePoints, Side } from '../../scoring/board'
import { saveBoard } from '../../scoring/boards'
import type { Match } from '../../scoring/demoMatches'
import { draftHash, nowSeconds, replacesOf, resultOf, type Fragment } from '../../scoring/fragment'
import { signWithDeviceKey } from '../../signing/deviceKey'
import { signResult } from '../../signing/envelope'
import { base64url } from '../../signing/text'
import { PATH } from './sides'

export type SubmitResult = ReturnType<typeof useSubmitResult>

// Submit puts the submitted games in the URL as a draft before it signs,
// so a failed signing keeps the deciding score. The pad remounts on that
// save, so its parent holds the mutation and its error.
export function useSubmitResult(match: Match, fragment: Fragment) {
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
      saveBoard(match.id, draft)
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
    onSuccess: (envelope) => {
      const hash = base64url(envelope)
      saveBoard(match.id, hash)
      return navigate({ to: '/matches/$matchId/scores/submission', params: { matchId: match.id }, search: true, hash })
    },
  })
}

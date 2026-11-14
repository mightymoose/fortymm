import { loadCore } from './load.ts'

// Whether this device loaded the shared core, with an answer only the core can
// give: the generated username of a fixed player id. The id and its username
// are a golden vector of the core's (core/vectors/vectors.json, "usernames"),
// so a core that loaded and answered gives exactly that name. /health shows it.
export const checkedPlayerId =
  'e2286f7cd2dc62c15a00bdb33f6e78167112a99a9f072d066e4e9dd3fc9d1c25'
const checkedSuffixLength = 4

export type CoreCheck =
  | { loaded: true; playerId: string; username: string }
  | { loaded: false }

// Never throws: a core that doesn't load is an answer, { loaded: false }.
export async function checkCore(): Promise<CoreCheck> {
  try {
    const core = await loadCore()
    return {
      loaded: true,
      playerId: checkedPlayerId,
      username: core.username(bytesOfHex(checkedPlayerId), checkedSuffixLength),
    }
  } catch {
    return { loaded: false }
  }
}

function bytesOfHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

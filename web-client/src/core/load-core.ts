import init, {
  account_id,
  compress_public_key,
  hello_world,
  own_player_id,
  username,
} from 'fortymm-core-wasm'

// The core's functions, once its wasm has loaded. Only these work before init() resolves: calling
// the package's exports directly before then throws. A function given bytes of the wrong form
// throws an Error saying why.
export interface Core {
  hello_world: () => string
  // The 33-byte compressed form of a public key exported raw by WebCrypto (65 bytes).
  compress_public_key: (uncompressed: Uint8Array) => Uint8Array
  // The account id and own player id (32 bytes each) of a 33-byte compressed public key.
  account_id: (publicKey: Uint8Array) => Uint8Array
  own_player_id: (publicKey: Uint8Array) => Uint8Array
  // The generated username of a 32-byte player id, with a 4- to 16-character suffix.
  username: (playerId: Uint8Array, suffixLength: number) => string
}

const core: Core = { hello_world, compress_public_key, account_id, own_player_id, username }

let loading: Promise<Core> | undefined

// Fetches and instantiates the core's .wasm (Vite serves it and resolves its URL) the first time,
// then shares that load. A failed load is forgotten, so the next call tries again.
export function loadCore(): Promise<Core> {
  loading ??= init().then(
    () => core,
    (error: unknown) => {
      loading = undefined
      throw error
    },
  )
  return loading
}

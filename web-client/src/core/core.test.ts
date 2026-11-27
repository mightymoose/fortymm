/// <reference types="node" />
// The core's wasm package (core/bindings/wasm), built into the image. Tests load the module's
// bytes from disk: jsdom has no fetch for file URLs, which init() would use.
import { readFileSync } from 'node:fs'
import { hello_world, initSync } from 'fortymm-core-wasm'
import { beforeAll, describe, expect } from 'vitest'
import { it } from '../setupTests.ts'

beforeAll(() => {
  initSync({ module: readFileSync('node_modules/fortymm-core-wasm/fortymm_core_wasm_bg.wasm') })
})

describe('the core', () => {
  it('greets the world', () => {
    expect(hello_world()).toBe('Hello World')
  })
})

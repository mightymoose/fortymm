/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repositoryRoot = resolve(process.cwd(), '..')

function repositoryFile(path: string) {
  return readFileSync(`${repositoryRoot}/${path}`, 'utf8')
}

describe('Stripe browser configuration', () => {
  it('passes VITE_STRIPE_PUBLISHABLE_KEY into the published web image build', () => {
    expect(repositoryFile('.github/workflows/publish.yml')).toMatch(
      /^\s+VITE_STRIPE_PUBLISHABLE_KEY=\$\{\{ secrets\.VITE_STRIPE_PUBLISHABLE_KEY }}$/m,
    )
  })

  it('passes VITE_STRIPE_PUBLISHABLE_KEY into the QA web image build', () => {
    expect(repositoryFile('docker-compose.qa.yml')).toMatch(
      /^\s+VITE_STRIPE_PUBLISHABLE_KEY: \$\{VITE_STRIPE_PUBLISHABLE_KEY:-}$/m,
    )
  })

  it('passes VITE_STRIPE_PUBLISHABLE_KEY into the local Vite dev server', () => {
    expect(repositoryFile('docker-compose.dev.yml')).toMatch(
      /^\s+VITE_STRIPE_PUBLISHABLE_KEY: \$\{VITE_STRIPE_PUBLISHABLE_KEY:-}$/m,
    )
  })

  it('bakes VITE_STRIPE_PUBLISHABLE_KEY into the web image bundle', () => {
    const dockerfile = repositoryFile('web-client/Dockerfile.uat')

    expect(dockerfile).toMatch(/^ARG VITE_STRIPE_PUBLISHABLE_KEY=/m)
    expect(dockerfile).toMatch(
      /^ENV VITE_STRIPE_PUBLISHABLE_KEY=\$VITE_STRIPE_PUBLISHABLE_KEY$/m,
    )
  })
})

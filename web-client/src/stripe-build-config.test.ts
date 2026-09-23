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

  it('refuses to publish a web artifact without its Stripe browser key', () => {
    const workflow = repositoryFile('.github/workflows/publish.yml')
    const webJobStart = workflow.indexOf('\n  web-client:')
    const chartJobStart = workflow.indexOf('\n  chart:', webJobStart)
    const webJob = workflow.slice(webJobStart, chartJobStart)
    const requiredKeyGuard = webJob.indexOf(
      '${VITE_STRIPE_PUBLISHABLE_KEY:?',
    )
    const imageBuild = webJob.indexOf('uses: docker/build-push-action@v7')

    expect(webJobStart).toBeGreaterThan(-1)
    expect(chartJobStart).toBeGreaterThan(webJobStart)
    expect(webJob).toMatch(
      /^\s+VITE_STRIPE_PUBLISHABLE_KEY: \$\{\{ secrets\.VITE_STRIPE_PUBLISHABLE_KEY }}$/m,
    )
    expect(requiredKeyGuard).toBeGreaterThan(-1)
    expect(requiredKeyGuard).toBeLessThan(imageBuild)
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

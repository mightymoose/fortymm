import { createFileRoute } from '@tanstack/react-router'
import { Home } from '../../../pages/Home'
import { SAMPLES, VARIANTS, type Sample, type Variant } from '../../../pages/dashboard/search'

type HomeSearch = { signed_in?: 1; variant?: Variant; sample?: Sample }

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  values.find((v) => v === value)

export const Route = createFileRoute('/_authenticated/_shell/')({
  // The API's callback adds `signed_in=1` after a sign-in. The router parses
  // the 1 as a number. `variant` and `sample` pick the dashboard prototype's
  // option and data.
  validateSearch: (search: Record<string, unknown>): HomeSearch => {
    const variant = oneOf(VARIANTS, search.variant)
    const sample = variant && oneOf(SAMPLES, search.sample)
    return {
      ...(search.signed_in === 1 || search.signed_in === '1' ? { signed_in: 1 } : {}),
      ...(variant ? { variant } : {}),
      ...(sample ? { sample } : {}),
    }
  },
  component: Home,
})

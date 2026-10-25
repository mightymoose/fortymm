import { createFileRoute } from '@tanstack/react-router'
import { Home } from '../../pages/Home'
import { isSignInPromptDesign, type SignInPromptDesign } from '../../pages/signInPromptDesigns'

export const Route = createFileRoute('/_authenticated/')({
  validateSearch: (search: Record<string, unknown>): { prompt?: SignInPromptDesign } =>
    isSignInPromptDesign(search.prompt) ? { prompt: search.prompt } : {},
  component: Home,
})

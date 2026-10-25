// The designs of the sign-in prompt on Home, for review on one Preview (#61).
// `/?prompt=<design>` shows one. Without it, Home shows the first.
export const signInPromptDesigns = ['alert', 'notice', 'card', 'hero', 'strip'] as const

export type SignInPromptDesign = (typeof signInPromptDesigns)[number]

export function isSignInPromptDesign(value: unknown): value is SignInPromptDesign {
  return signInPromptDesigns.includes(value as SignInPromptDesign)
}

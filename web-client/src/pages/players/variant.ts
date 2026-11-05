export const variants = ['a', 'b', 'c'] as const
export type Variant = (typeof variants)[number]

export const parseVariant = (value: unknown): Variant | undefined =>
  variants.find((variant) => variant === value)

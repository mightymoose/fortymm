import type { HoneypotProps } from './honeypot'

/** A clean mount of the bot trap — empty and waiting. */
export function buildHoneypotProps(
  overrides: Partial<HoneypotProps> = {},
): HoneypotProps {
  return {
    value: '',
    onChange: vi.fn(),
    testId: 'honeypot',
    ...overrides,
  }
}

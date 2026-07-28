import type { CopyFieldProps } from './copy-field'

/**
 * The connector-URL field, untouched: nothing copied yet, so no marker and no
 * failure line. Pass `outcome` to build either of the other two states.
 */
export function buildCopyFieldProps(
  overrides: Partial<CopyFieldProps> = {},
): CopyFieldProps {
  return {
    label: 'Connector URL',
    value: 'https://fortymm.com/api/mcp/',
    buttonLabel: 'Copy URL',
    tone: 'primary',
    outcome: null,
    onCopy: () => {},
    ...overrides,
  }
}

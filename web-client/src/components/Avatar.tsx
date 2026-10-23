import { useAvatarGroupSize } from './avatarGroupContext'

export type AvatarSize = 'sm' | 'md' | 'lg'

export type AvatarTone = 'neutral' | 'brand' | 'blue' | 'red' | 'green'

const sizeClasses: Record<AvatarSize, string> = {
  sm: 'avatar--sm',
  md: 'avatar--md',
  lg: 'avatar--lg',
}

const toneClasses: Record<AvatarTone, string> = {
  neutral: 'avatar--neutral',
  brand: 'avatar--brand',
  blue: 'avatar--blue',
  red: 'avatar--red',
  green: 'avatar--green',
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/)
  const first = words[0][0] ?? ''
  const last = words.length > 1 ? words[words.length - 1][0] : ''
  return (first + last).toUpperCase()
}

// The circle an Avatar and an AvatarGroup's overflow are both drawn as,
// styled by `.avatar` in styles/base.css. Its text only repeats the label,
// so assistive tech reads the label alone.
export function AvatarCircle({
  label,
  text,
  size,
  tone,
}: {
  label: string
  text: string
  size: AvatarSize
  tone: AvatarTone
}) {
  return (
    <span
      role="img"
      aria-label={label}
      className={`avatar ${sizeClasses[size]} ${toneClasses[tone]}`}
    >
      <span aria-hidden="true">{text}</span>
    </span>
  )
}

// A person shown by their initials. Inside an AvatarGroup it takes the
// group's size unless given its own.
export function Avatar({
  name,
  size,
  tone = 'neutral',
}: {
  name: string
  size?: AvatarSize
  tone?: AvatarTone
}) {
  const groupSize = useAvatarGroupSize()
  return (
    <AvatarCircle
      label={name}
      text={initials(name)}
      size={size ?? groupSize ?? 'md'}
      tone={tone}
    />
  )
}

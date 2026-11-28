// A person, as flat initials in a circle (the kit's .fm-avatar; the More board: "Avatars are flat
// initials"). The initials are what is seen; `name`, who it is, is what assistive technology
// reads, so the avatar is an image named by it.
export function Avatar({ initials, name }: { initials: string; name: string }) {
  return (
    <span className="fm-avatar" role="img" aria-label={name}>
      {initials}
    </span>
  )
}

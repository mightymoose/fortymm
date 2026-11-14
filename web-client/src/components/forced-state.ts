// A state a control is drawn in without anyone causing it, the way the
// design system's state matrix shows one (its `.is-hover`, `.is-focus` and
// `.is-active` classes): the control is drawn hovered, focused or pressed,
// and nothing about its behaviour changes. Only the design system page sets
// one (ControlsSection). A control renders it as `data-forced-state`, and its
// stylesheet gives that attribute the same look as the real state.
export type ForcedState = 'hover' | 'focus' | 'pressed'

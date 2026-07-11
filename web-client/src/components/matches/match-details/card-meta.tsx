import { type ReactNode } from "react";

import { CardAction } from "@/components/ui/card";

/**
 * The trailing caption in a match-details panel header — the head-to-head
 * meeting count, the players panel's snapshot label.
 *
 * `text-muted-foreground` looks like the right design-system token here and is
 * not: `.fortymm-theme` remaps it to the lighter `--chalk-300`. `--fg-muted`
 * (`--chalk-500`) is the grey these captions have always been, back when they
 * shared the one `.md-card__hd-meta` rule. Keep it.
 *
 * `self-center` centres the caption against the overline, which `CardHeader`
 * would otherwise top-align in its `items-start` grid.
 */
export const CARD_META_CLASS =
  "self-center text-[11px] font-medium tracking-[0.08em] text-[color:var(--fg-muted)]";

export interface CardMetaProps {
  children: ReactNode;
}

export const CardMeta = ({ children }: CardMetaProps) => (
  <CardAction className={CARD_META_CLASS}>{children}</CardAction>
);

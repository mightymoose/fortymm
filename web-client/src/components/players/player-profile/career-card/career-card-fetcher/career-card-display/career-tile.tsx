import type { CareerTileView } from '../career-card-query'

export interface CareerTileProps {
  tile: CareerTileView
}

/**
 * One of the Career card's two small tiles — **Best streak** and **Games won**.
 *
 * Pure label/value: the projection has already decided what the value reads,
 * including the `—` a player with no such number gets. The tile never formats a
 * number itself, and so can never turn a share into a "0%".
 */
export const CareerTile = ({ tile }: CareerTileProps) => (
  <div className="career-card__tile">
    <span className="career-card__tile-k">{tile.label}</span>
    <span className="career-card__tile-v">{tile.value}</span>
  </div>
)

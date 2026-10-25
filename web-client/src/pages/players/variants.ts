import type { ComponentType } from 'react'
import { CardsDetail, CardsList } from './CardsVariant'
import { LadderDetail, LadderList } from './LadderVariant'
import { RowsDetail, RowsList } from './RowsVariant'
import type { DetailScenario, ListScenario } from './scenarios'
import { SplitDetail, SplitList } from './SplitVariant'
import { TableDetail, TableList } from './TableVariant'
import type { VariantSlug } from './variantSlugs'

export type Variant = {
  name: string
  summary: string
  List: ComponentType<{ scenario: ListScenario }>
  Detail: ComponentType<{ playerId: string; scenario: DetailScenario }>
}

// Each mockup of the players list and its player page, in the order the
// index lists them.
export const variants: Record<VariantSlug, Variant> = {
  table: {
    name: 'Ratings table',
    summary: 'A dense table of one league at a time, picked from a list. The player page has a row for each league.',
    List: TableList,
    Detail: TableDetail,
  },
  cards: {
    name: 'Cards',
    summary: 'A card per player with their rating in each league. The player page has a card for each league.',
    List: CardsList,
    Detail: CardsDetail,
  },
  rows: {
    name: 'Searchable rows',
    summary: 'A phone-first list that searches names, clubs and leagues. The player page is a single column.',
    List: RowsList,
    Detail: RowsDetail,
  },
  split: {
    name: 'List and player',
    summary: 'The list and one player side by side, with a tab for each league. The player can fail while the list stays.',
    List: SplitList,
    Detail: SplitDetail,
  },
  ladder: {
    name: 'League ladders',
    summary: 'A ladder for each league, a tab each. The player page shows their place on each ladder and who’s near.',
    List: LadderList,
    Detail: LadderDetail,
  },
}

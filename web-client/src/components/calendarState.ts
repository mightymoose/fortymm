import { useReducer } from 'react'
import { dateFromIso, isoDate, type IsoDate } from './dates'

// A date picker's settings, as the gallery's `data-datepicker` gives them.
// `today` is outlined, and days before `min` can't be picked.
export type CalendarConfig = {
  value?: IsoDate
  today: IsoDate
  min?: IsoDate
}

// What a calendar shows: the picked day, the day that takes focus (the one
// day in the grid that's tabbable) and the month on screen, as its 1st.
export type CalendarState = {
  selected: IsoDate | null
  focused: IsoDate
  month: IsoDate
}

export type CalendarAction =
  // Moves focus to `date`, showing its month.
  | { type: 'focus'; date: Date }
  // Shows the month `delta` months away, focusing its 1st.
  | { type: 'showMonth'; delta: number }
  // Picks `date` from the grid. The month stays, as in kit.js.
  | { type: 'pick'; date: Date }
  // Takes a date typed in the field, or null when the field was emptied.
  | { type: 'type'; date: Date | null }

function monthOf(date: Date): IsoDate {
  return isoDate(new Date(date.getFullYear(), date.getMonth(), 1))
}

export function initialCalendar({ value, today }: CalendarConfig): CalendarState {
  const focused = value ?? today
  return { selected: value ?? null, focused, month: monthOf(dateFromIso(focused)) }
}

export function calendarReducer(state: CalendarState, action: CalendarAction): CalendarState {
  switch (action.type) {
    case 'focus':
      return { ...state, focused: isoDate(action.date), month: monthOf(action.date) }
    case 'showMonth': {
      const month = dateFromIso(state.month)
      const shown = isoDate(new Date(month.getFullYear(), month.getMonth() + action.delta, 1))
      return { ...state, focused: shown, month: shown }
    }
    case 'pick':
      return { ...state, selected: isoDate(action.date), focused: isoDate(action.date) }
    case 'type':
      if (!action.date) return { ...state, selected: null }
      return {
        selected: isoDate(action.date),
        focused: isoDate(action.date),
        month: monthOf(action.date),
      }
  }
}

// A calendar's state and the dispatch that changes it.
export type CalendarModel = {
  state: CalendarState
  dispatch: (action: CalendarAction) => void
}

export function useCalendar(config: CalendarConfig): CalendarModel {
  const [state, dispatch] = useReducer(calendarReducer, config, initialCalendar)
  return { state, dispatch }
}

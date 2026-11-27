import { createContext } from 'react'
import { type RadioGroupState } from 'react-stately'

// The state of the RadioGroup a Radio is in.
export const RadioGroupContext = createContext<RadioGroupState | null>(null)

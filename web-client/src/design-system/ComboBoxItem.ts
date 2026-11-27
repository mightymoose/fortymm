// One choice in a ComboBox: its name, and what tells it apart from others with the same name (e.g.
// a player's club below, and their rating at the right).
export interface ComboBoxItem {
  id: string
  name: string
  description?: string
  meta?: string
}

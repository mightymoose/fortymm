// The gallery's checked-in players, as its opponent combobox and command
// palette list them.
export type CheckedInPlayer = { name: string; club: string; rating: string }

export const checkedInPlayers: readonly CheckedInPlayer[] = [
  { name: 'Nguyen, Thanh', club: 'Riverside TT', rating: '2,145' },
  { name: 'Nguyen, Linh', club: 'Eastgate', rating: '1,702' },
  { name: 'Wójcik-Szymańska, Agnieszka', club: 'Northside', rating: '2,088' },
  { name: 'Okafor-Adeyemi, Daniel', club: 'Eastgate', rating: '1,987' },
  { name: 'Johansen-Whitfield, Annika', club: 'Northside', rating: '2,061' },
  { name: 'Patel, Meera', club: 'Riverside TT', rating: '1,840' },
  { name: 'Park, Ji-ho', club: 'Eastgate', rating: '1,812' },
  { name: 'Fernández-Castillo, Marisol', club: 'Northside', rating: '1,765' },
  { name: 'Moreau, Élodie', club: 'Eastgate', rating: '1,930' },
  { name: 'Lindqvist, Erik', club: 'Northside', rating: '1,688' },
  { name: 'Chen, Wei', club: 'Riverside TT', rating: '1,901' },
  { name: 'Ali, Rashid', club: 'Eastgate', rating: '1,745' },
]

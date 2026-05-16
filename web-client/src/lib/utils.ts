import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Two-letter monogram for an avatar bubble: first letter of each of the
 * first two name parts, or the first two characters when there's only one
 * part. Splits on whitespace and common username separators. */
export function initialsOf(name: string): string {
  const parts = name.split(/[.\s_-]+/).filter(Boolean)
  if (parts.length === 0) return name.slice(0, 2).toUpperCase()
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

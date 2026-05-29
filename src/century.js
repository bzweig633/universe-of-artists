// Century metadata used across layouts and legends.
// The 'century' field on each node is now derived server-side from movements,
// so no lookup map is needed here — we just colour and label by century value.

export const CENTURIES = [14, 15, 16, 17, 18, 19, 20, 21]

export const CENTURY_LABELS = {
  14: '14th c.', 15: '15th c.', 16: '16th c.', 17: '17th c.',
  18: '18th c.', 19: '19th c.', 20: '20th c.', 21: '21st c.',
}

export const CENTURY_COLORS = [
  '#f472b6', // 14th — pink
  '#c084fc', // 15th — purple
  '#fb923c', // 16th — orange
  '#fbbf24', // 17th — amber
  '#34d399', // 18th — green
  '#38bdf8', // 19th — blue
  '#e879f9', // 20th — fuchsia
  '#a3e635', // 21st — lime
]

// Read the century directly from the node — set by the data pipeline
export function getCentury(node) {
  return node.century ?? 19
}

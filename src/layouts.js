import { CENTURIES, CENTURY_LABELS, getCentury, CENTURY_COLORS } from './century.js'

export { CENTURIES, CENTURY_LABELS, getCentury, CENTURY_COLORS }

const SPACE = 4096
const CX = SPACE / 2
const CY = SPACE / 2

export function getLayout(mode, nodes) {
  switch (mode) {
    case 'clusters': return layoutClusters(nodes)
    case 'radial':   return layoutRadial(nodes)
    case 'worm':     return layoutWorm(nodes)
    default:         return { clusterIndices: null, clusterPositions: null, spaceSize: SPACE }
  }
}

// ── Clusters: A–Z buckets ─────────────────────────────────────────
export const CLUSTER_COLORS = ['#a78bfa','#34d399','#fb923c','#38bdf8','#f472b6']
const CLUSTER_R = SPACE * 0.28

export function nameToCluster(name) {
  const ch = (name?.replace(/^'/, '')[0] ?? 'A').toUpperCase().charCodeAt(0)
  return Math.floor(Math.max(0, ch - 65) / 6) % 5
}

function layoutClusters(nodes) {
  const indices = new Float32Array(nodes.map(n => nameToCluster(n.name)))
  const positions = new Float32Array(
    [0,1,2,3,4].flatMap(i => {
      const a = (i/5)*Math.PI*2 - Math.PI/2
      return [CX + Math.cos(a)*CLUSTER_R, CY + Math.sin(a)*CLUSTER_R]
    })
  )
  return { clusterIndices: indices, clusterPositions: positions, spaceSize: SPACE }
}

// ── Radial by century ────────────────────────────────────────────
const RADIAL_R = SPACE * 0.32

function layoutRadial(nodes) {
  const indices = new Float32Array(
    nodes.map(n => Math.max(0, CENTURIES.indexOf(getCentury(n))))
  )
  const positions = new Float32Array(
    CENTURIES.flatMap((_, i) => {
      const a = (i/CENTURIES.length)*Math.PI*2 - Math.PI/2
      return [CX + Math.cos(a)*RADIAL_R, CY + Math.sin(a)*RADIAL_R]
    })
  )
  return { clusterIndices: indices, clusterPositions: positions, spaceSize: SPACE }
}

// ── Worm: sequential spine ───────────────────────────────────────
const WORM_SEGS = 8
export const WORM_COLORS = ['#fb923c','#fbbf24','#f97316','#ef4444','#f59e0b','#fb923c','#fcd34d','#fca5a5']

function layoutWorm(nodes) {
  const perSeg = Math.ceil(nodes.length / WORM_SEGS)
  const indices = new Float32Array(
    nodes.map((_, i) => Math.min(Math.floor(i / perSeg), WORM_SEGS - 1))
  )
  const margin = SPACE * 0.12
  const span   = SPACE - margin * 2
  const positions = new Float32Array(
    Array.from({ length: WORM_SEGS }, (_, s) => {
      const t = s / (WORM_SEGS - 1)
      return [margin + t * span, CY + Math.sin(t * Math.PI) * SPACE * 0.18]
    }).flat()
  )
  return { clusterIndices: indices, clusterPositions: positions, spaceSize: SPACE }
}

// ── Node colour by layout mode ────────────────────────────────────
export function nodeColor(node, nodeIdx, totalNodes, mode) {
  if (mode === 'radial') {
    const i = Math.max(0, CENTURIES.indexOf(getCentury(node)))
    return CENTURY_COLORS[i] ?? '#888'
  }
  if (mode === 'clusters') {
    return CLUSTER_COLORS[nameToCluster(node.name)]
  }
  if (mode === 'worm') {
    const perSeg = Math.ceil(totalNodes / WORM_SEGS)
    const seg = Math.min(Math.floor(nodeIdx / perSeg), WORM_SEGS - 1)
    return WORM_COLORS[seg]
  }
  // force / mesh — by degree
  const d = node.degree
  if (d >= 40) return '#c084fc'
  if (d >= 20) return '#38bdf8'
  if (d >= 10) return '#34d399'
  return '#5b6dca'  // muted indigo — distinguishes <10 nodes from gray UI chrome
}

import { Graph } from '@cosmos.gl/graph'
import {
  getLayout, nodeColor,
  CLUSTER_COLORS, CENTURY_COLORS, WORM_COLORS,
  CENTURIES, CENTURY_LABELS, getCentury,
} from './layouts.js'

// ── DOM refs ─────────────────────────────────────────────────────
const container     = document.getElementById('graph-container')
const canvasWrap    = document.getElementById('canvas-wrap')
const loadBadge     = document.getElementById('loading-badge')
const infoName      = document.getElementById('info-name')
const infoMeta      = document.getElementById('info-meta')
const dataStats     = document.getElementById('data-stats')
const legendEl      = document.getElementById('legend')
const navBtns       = document.querySelectorAll('.layout-btn')
const ctrlRep       = document.getElementById('ctrl-repulsion')
const valRep        = document.getElementById('val-repulsion')
const ctrlNodeScale = document.getElementById('ctrl-node-scale')
const valNodeScale  = document.getElementById('val-node-scale')
const ctrlLabels    = document.getElementById('ctrl-labels')
const ctrlStyle     = document.getElementById('ctrl-style')
const btnReset      = document.getElementById('btn-reset')
const btnSimPause   = document.getElementById('btn-pause')
const searchInput   = document.getElementById('search-input')
const searchClear   = document.getElementById('search-clear')
const searchResults = document.getElementById('search-results')
const searchWrap    = document.getElementById('search-wrap')
const filterBtn     = document.getElementById('filter-btn')
const filterLabel   = document.getElementById('filter-label')
const filterPanel   = document.getElementById('filter-panel')
const filterSearch  = document.getElementById('filter-search')
const filterList    = document.getElementById('filter-list')
const tooltip       = document.getElementById('node-tooltip')
const ttName        = tooltip.querySelector('.tt-name')
const ttMeta        = tooltip.querySelector('.tt-meta')
const ttNeighbors   = tooltip.querySelector('.tt-neighbors')

// ── State ─────────────────────────────────────────────────────────
let graph         = null
let nodes         = []           // [{ id, name, degree, century, movement, movements }]
let linkPairs     = []           // [[srcIdx, tgtIdx], …]
let adjacency     = new Map()    // nodeIdx → Set<neighbour name>
let currentLayout = 'force'
let repulsion     = 0.35
let nodeScale     = 1.0
let showLabels    = false
let linkStyle     = 'curved'
let simPaused     = false
let hoveredIdx    = -1
let mouseX        = 0
let mouseY        = 0
let searchMatches  = []
let activeResultIdx = -1
let isSelectingResult = false
let movementsManifest = []     // [{name, century, count}] from JSON meta
let selectedMovement  = null   // current filter — null means show all
let focusedNodeIdx    = -1     // search-selected node — its 1-hop neighbours stay bright
let focusedNeighbours = null   // Set<idx> of neighbours of focusedNodeIdx (precomputed)
let selectedDiscipline = 'all' // 'all' | 'painter' | 'sculptor' | 'architect'

// ── Load data ─────────────────────────────────────────────────────
// New schema (artist_network.json):
//   nodes: [{ id: 'a1', name: 'Alice', degree: N, century: 19, movement: 'X', movements: ['X','Y'] }]
//   links: [{ source: 'a1', target: 'a37' }]
async function loadData() {
  const res = await fetch('./artist_network.json')
  if (!res.ok) throw new Error(`HTTP ${res.status} loading artist_network.json`)
  const raw = await res.json()

  // Capture top-level movements manifest for filter UI
  movementsManifest = raw.movements ?? []

  // Filter to nodes that appear in at least one link (full dataset already does, but safe).
  // Build name lookups from the new schema fields (id, name, degree).
  const nodeIdToData = new Map()
  for (const n of raw.nodes) {
    nodeIdToData.set(n.id, n)
  }

  // Build the active node set by collecting all link endpoints
  const idSet = new Set()
  for (const l of raw.links) {
    idSet.add(l.source)
    idSet.add(l.target)
  }

  // Only include nodes with at least one connection (parity with old behaviour)
  nodes = [...idSet]
    .map(id => nodeIdToData.get(id))
    .filter(Boolean)

  // Map id → array index for cosmos.gl Float32Array references
  const idxMap = new Map(nodes.map((n, i) => [n.id, i]))

  // Convert {source, target} link objects to [srcIdx, tgtIdx] pairs
  linkPairs = raw.links
    .filter(l => idxMap.has(l.source) && idxMap.has(l.target))
    .map(l => [idxMap.get(l.source), idxMap.get(l.target)])

  // Adjacency map: nodeIdx → Set of neighbour NAMES (for tooltip)
  adjacency = new Map(nodes.map((_, i) => [i, new Set()]))
  for (const [a, b] of linkPairs) {
    adjacency.get(a).add(nodes[b].name)
    adjacency.get(b).add(nodes[a].name)
  }

  dataStats.textContent =
    `${nodes.length.toLocaleString()} artists · ${linkPairs.length.toLocaleString()} connections`
}

// ── Config ────────────────────────────────────────────────────────
function buildConfig(mode) {
  return {
    spaceSize:              4096,
    backgroundColor:        '#080a10',
    simulationRepulsion:    repulsion,
    simulationGravity:      0.1,
    simulationFriction:     0.85,
    // Higher decay = simulation cools down faster (less violent expand/contract).
    // Default ~1000. Force and Mesh layouts have more freedom of motion, so they
    // benefit from higher decay; Worm and Radial have cluster pull holding them
    // in place already, so they look fine with lower values.
    simulationDecay:        mode === 'force' || mode === 'mesh' ? 5000 : 1000,
    simulationLinkSpring:   1.0,
    simulationLinkDistance: mode === 'mesh' ? 30 : 60,
    curvedLinks:            linkStyle === 'curved',
    renderLinks:            linkStyle !== 'off',
    scaleLinksOnZoom:       false,
    pointSizeScale:         nodeScale,
    hoveredLinkColor:        [0.65, 0.70, 0.80, 0.8],
    hoveredLinkWidthIncrease: 0,
    fitViewOnInit:          true,
    fitViewDelay:           500,
    fitViewPadding:         0.1,
    enableDrag:             true,
    onPointMouseOver: (idx) => {
      hoveredIdx = idx ?? -1
      renderTooltip(hoveredIdx, mouseX, mouseY)
    },
    onPointMouseOut: () => {
      hoveredIdx = -1
      hideTooltip()
    },
    onClick: (pointIndex) => {
      if (pointIndex == null) return
      const n = nodes[pointIndex]
      if (!n) return
      infoName.textContent = n.name
      infoName.style.color = nodeColor(n, pointIndex, nodes.length, currentLayout)
      infoMeta.textContent = `${n.degree} connections · ${CENTURY_LABELS[getCentury(n)] ?? ''}`
    },
  }
}

// ── Build typed arrays ────────────────────────────────────────────
function buildArrays(mode) {
  const N = nodes.length, L = linkPairs.length, SPACE = 4096

  const positions = new Float32Array(N * 2)
  for (let i = 0; i < N; i++) {
    positions[i * 2]     = Math.random() * SPACE
    positions[i * 2 + 1] = Math.random() * SPACE
  }

  const sizes = new Float32Array(N)
  for (let i = 0; i < N; i++) sizes[i] = Math.sqrt(nodes[i].degree) * 1.6 + 3

  const pointColors = new Float32Array(N * 4)
  for (let i = 0; i < N; i++) {
    const [r, g, b] = hexToRgb(nodeColor(nodes[i], i, N, mode))
    pointColors[i * 4] = r; pointColors[i * 4 + 1] = g
    pointColors[i * 4 + 2] = b; pointColors[i * 4 + 3] = 0.9
  }

  const links = new Float32Array(linkPairs.flatMap(([a, b]) => [a, b]))
  const linkColors = new Float32Array(L * 4)
  for (let i = 0; i < L; i++) {
    linkColors[i * 4] = 0.65; linkColors[i * 4 + 1] = 0.70
    linkColors[i * 4 + 2] = 0.80; linkColors[i * 4 + 3] = 0.8
  }
  const linkWidths = new Float32Array(L).fill(mode === 'mesh' ? 1.2 : 0.8)

  return { positions, sizes, pointColors, links, linkColors, linkWidths }
}

// ── Init graph ────────────────────────────────────────────────────
function initGraph(mode) {
  hideTooltip()
  clearSearch()
  simPaused = false
  updatePauseBtn()
  if (graph) { graph.destroy(); graph = null }

  graph = new Graph(container, buildConfig(mode))

  const { positions, sizes, pointColors, links, linkColors, linkWidths } = buildArrays(mode)
  graph.setPointPositions(positions)
  graph.setPointSizes(sizes)
  graph.setPointColors(pointColors)
  graph.setLinks(links)
  graph.setLinkColors(linkColors)
  graph.setLinkWidths(linkWidths)

  const { clusterIndices, clusterPositions } = getLayout(mode, nodes)
  if (clusterIndices && clusterPositions) {
    graph.setPointClusters(clusterIndices)
    graph.setClusterPositions(clusterPositions)
    graph.setPointClusterStrength(0.5)
  }

  graph.render()

  // Re-apply movement filter to the new graph instance
  // Re-apply movement/focus/discipline filter to the freshly created graph instance
  if (selectedMovement || focusedNodeIdx >= 0 || selectedDiscipline !== 'all') applyVisualFilter()
}

// ── Simulation pause/resume ───────────────────────────────────────
function updatePauseBtn() {
  btnSimPause.textContent = simPaused ? '▶ Resume' : '⏸ Pause'
  btnSimPause.classList.toggle('active', simPaused)
}

btnSimPause.addEventListener('click', () => {
  if (!graph) return
  if (simPaused) { graph.restart(); simPaused = false }
  else { graph.pause(); simPaused = true }
  updatePauseBtn()
})

// ── Search ────────────────────────────────────────────────────────
function positionDropdown() {
  const r = searchWrap.getBoundingClientRect()
  searchResults.style.top   = `${r.bottom + 4}px`
  searchResults.style.left  = `${r.left}px`
  searchResults.style.width = `${r.width}px`
}

function runSearch(q) {
  q = q.trim().toLowerCase()
  searchClear.hidden = !q
  if (!q) { clearSearch(); return }

  const exact = [], prefix = [], sub = []
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i], name = n.name.toLowerCase()
    if (name === q)              exact.push({ ...n, idx: i })
    else if (name.startsWith(q)) prefix.push({ ...n, idx: i })
    else if (name.includes(q))   sub.push({ ...n, idx: i })
  }
  const byDeg = arr => arr.sort((a, b) => b.degree - a.degree)
  searchMatches = [...byDeg(exact), ...byDeg(prefix), ...byDeg(sub)].slice(0, 20)
  activeResultIdx = searchMatches.length > 0 ? 0 : -1
  renderDropdown()
}

function renderDropdown() {
  if (!searchMatches.length) {
    searchResults.innerHTML = '<div class="sr-empty">No artists found</div>'
    positionDropdown()
    searchResults.hidden = false
    return
  }
  searchResults.innerHTML = ''
  searchMatches.forEach((m, i) => {
    const el = document.createElement('div')
    el.className = 'sr-item' + (i === activeResultIdx ? ' active' : '')
    el.setAttribute('role', 'option')
    el.innerHTML =
      `<span class="sr-item-name">${m.name}</span>` +
      `<span class="sr-item-deg">${m.degree} conn.</span>`
    el.addEventListener('click', () => selectResult(m))
    el.addEventListener('mouseenter', () => { activeResultIdx = i; renderDropdown() })
    searchResults.appendChild(el)
  })
  positionDropdown()
  searchResults.hidden = false
}

function selectResult(match) {
  isSelectingResult = false
  searchInput.value = match.name
  searchClear.hidden = false
  searchResults.hidden = true
  searchMatches = []
  searchInput.blur()

  // Set focus state — node + its direct neighbours stay bright,
  // everything else dims via applyVisualFilter()
  focusedNodeIdx = match.idx
  focusedNeighbours = new Set()
  for (const [a, b] of linkPairs) {
    if (a === match.idx) focusedNeighbours.add(b)
    else if (b === match.idx) focusedNeighbours.add(a)
  }
  applyVisualFilter()

  const wasPaused = simPaused
  if (!simPaused) { graph.pause(); simPaused = true; updatePauseBtn() }

  // Zoom: 2500ms (was 1500ms) gives a smoother, less abrupt camera move
  // Level 20 (was 40) — closer than the default 3 but not so deep that
  // the node fills the screen and context is lost. Adjust if you want
  // tighter or wider framing.
  graph.zoomToPointByIndex(match.idx, 2500, 20)

  if (!wasPaused) {
    setTimeout(() => {
      if (simPaused && !wasPaused) {
        graph.restart(); simPaused = false; updatePauseBtn()
      }
    }, 2600)
  }

  infoName.textContent = match.name
  infoName.style.color = nodeColor(match, match.idx, nodes.length, currentLayout)
  infoMeta.textContent = `${match.degree} connections · ${CENTURY_LABELS[getCentury(match)] ?? ''}`
}

function clearSearch() {
  isSelectingResult = false
  searchMatches = []
  activeResultIdx = -1
  searchResults.hidden = true
  searchInput.value = ''
  searchClear.hidden = true

  // Drop the focus dimming and refresh colours
  if (focusedNodeIdx >= 0) {
    focusedNodeIdx = -1
    focusedNeighbours = null
    if (graph) applyVisualFilter()
  }
}

searchResults.addEventListener('mousedown', () => { isSelectingResult = true })

searchInput.addEventListener('input', e => runSearch(e.target.value))
searchInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (!searchMatches.length) return; activeResultIdx = Math.min(activeResultIdx + 1, searchMatches.length - 1); renderDropdown() }
  else if (e.key === 'ArrowUp')   { e.preventDefault(); activeResultIdx = Math.max(activeResultIdx - 1, 0); renderDropdown() }
  else if (e.key === 'Enter')     { const t = activeResultIdx >= 0 ? searchMatches[activeResultIdx] : searchMatches[0]; if (t) selectResult(t) }
  else if (e.key === 'Escape')    { clearSearch(); searchInput.blur() }
})
searchInput.addEventListener('focus', () => {
  if (searchMatches.length) { positionDropdown(); searchResults.hidden = false }
})
searchInput.addEventListener('blur', () => {
  if (isSelectingResult) return
  searchResults.hidden = true
})
searchClear.addEventListener('click', () => { clearSearch(); searchInput.focus() })

// ── Tooltip ───────────────────────────────────────────────────────
function renderTooltip(idx, clientX, clientY) {
  if (!showLabels || idx < 0) { hideTooltip(); return }
  const n = nodes[idx]
  if (!n) { hideTooltip(); return }

  ttName.textContent = n.name
  ttName.style.color = nodeColor(n, idx, nodes.length, currentLayout)
  const discText = n.disciplines?.length ? ' · ' + n.disciplines.join(' / ') : ''
  ttMeta.textContent = `${n.degree} connections · ${CENTURY_LABELS[getCentury(n)] ?? ''}${n.movement ? ' · ' + n.movement : ''}${discText}`

  const neighbourNames = [...(adjacency.get(idx) ?? [])]
  const nameToNode = new Map(nodes.map(nd => [nd.name, nd]))
  const sorted = neighbourNames
    .map(name => ({ name, degree: nameToNode.get(name)?.degree ?? 0 }))
    .sort((a, b) => b.degree - a.degree)

  const MAX = 8
  ttNeighbors.innerHTML = !sorted.length ? '' :
    `<div class="nb-label">Connected to</div>` +
    sorted.slice(0, MAX).map(nb => `<div>${nb.name}</div>`).join('') +
    (sorted.length > MAX ? `<div style="color:var(--muted);margin-top:3px">+${sorted.length - MAX} more</div>` : '')

  const rect = canvasWrap.getBoundingClientRect()
  let tx = clientX - rect.left + 18, ty = clientY - rect.top - 10
  if (tx + 256 > rect.width)  tx = clientX - rect.left - 274
  if (ty + 220 > rect.height) ty = rect.height - 224
  if (tx < 4) tx = 4; if (ty < 4) ty = 4

  tooltip.style.left = `${tx}px`; tooltip.style.top = `${ty}px`
  tooltip.classList.add('visible')
  tooltip.setAttribute('aria-hidden', 'false')
}

function hideTooltip() {
  hoveredIdx = -1
  tooltip.classList.remove('visible')
  tooltip.setAttribute('aria-hidden', 'true')
}

// ── Legend ────────────────────────────────────────────────────────
function buildLegend(mode) {
  legendEl.innerHTML = ''
  const items = (() => {
    if (mode === 'radial') return CENTURIES.map((c, i) => {
      const count = nodes.filter(n => getCentury(n) === c).length
      return count ? { color: CENTURY_COLORS[i], label: `${CENTURY_LABELS[c]} (${count})` } : null
    }).filter(Boolean)
    if (mode === 'clusters') return ['A–E','F–K','L–R','S–V','W–Z'].map((label, i) => ({ color: CLUSTER_COLORS[i], label }))
    if (mode === 'worm')     return WORM_COLORS.map((color, i) => ({ color, label: `Segment ${i + 1}` }))
    if (mode === 'mesh')     return []
    return [
      { color: '#c084fc', label: '40+ connections' },
      { color: '#38bdf8', label: '20–39' },
      { color: '#34d399', label: '10–19' },
      { color: '#5b6dca', label: '< 10' },
    ]
  })()
  items.forEach(({ color, label }) => {
    const el = document.createElement('div')
    el.className = 'legend-item'
    el.innerHTML = `<div class="legend-dot" style="background:${color}"></div>${label}`
    legendEl.appendChild(el)
  })
}

// ── Layout switcher ───────────────────────────────────────────────
function switchLayout(mode) {
  currentLayout = mode
  navBtns.forEach(btn => {
    const active = btn.dataset.layout === mode
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-pressed', String(active))
  })
  buildLegend(mode)
  initGraph(mode)
}

// ── Controls ──────────────────────────────────────────────────────
ctrlNodeScale.addEventListener('input', () => {
  nodeScale = parseInt(ctrlNodeScale.value) / 100
  valNodeScale.textContent = nodeScale.toFixed(1) + '×'
  if (!graph) return
  graph.setConfig(buildConfig(currentLayout))
})
ctrlLabels.addEventListener('click', () => {
  showLabels = !showLabels
  ctrlLabels.textContent = showLabels ? 'On' : 'Off'
  ctrlLabels.classList.toggle('on', showLabels)
  ctrlLabels.setAttribute('aria-pressed', String(showLabels))
  if (!showLabels) hideTooltip()
  else if (hoveredIdx >= 0) renderTooltip(hoveredIdx, mouseX, mouseY)
})
ctrlRep.addEventListener('input', () => {
  repulsion = parseInt(ctrlRep.value) / 100
  valRep.textContent = repulsion.toFixed(2)
  if (!graph) return
  graph.setConfig(buildConfig(currentLayout))
  if (!simPaused) graph.restart()
})
ctrlStyle.addEventListener('change', () => { linkStyle = ctrlStyle.value; initGraph(currentLayout) })
btnReset.addEventListener('click', () => graph?.fitView())
navBtns.forEach(btn => btn.addEventListener('click', () => switchLayout(btn.dataset.layout)))

// Discipline filter — dropdown
const discBtn   = document.getElementById('disc-btn')
const discLabel = document.getElementById('disc-label')
const discPanel = document.getElementById('disc-panel')

function positionDiscPanel() {
  const r = discBtn.getBoundingClientRect()
  discPanel.style.top  = `${r.bottom + 4}px`
  discPanel.style.left = `${r.left}px`
}

function toggleDiscPanel(open) {
  const isOpen = open ?? discPanel.hidden
  if (isOpen) {
    positionDiscPanel()
    discPanel.hidden = false
    discBtn.setAttribute('aria-expanded', 'true')
  } else {
    discPanel.hidden = true
    discBtn.setAttribute('aria-expanded', 'false')
  }
}

const DISC_LABELS = {
  all:       'All artists',
  painter:   'Painters',
  sculptor:  'Sculptors',
  architect: 'Architects',
}

function selectDiscipline(disc) {
  selectedDiscipline = disc
  discLabel.textContent = DISC_LABELS[disc]
  discBtn.classList.toggle('active', disc !== 'all')
  document.querySelectorAll('.d-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.discipline === disc)
  })
  toggleDiscPanel(false)
  applyVisualFilter()
}

discBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  toggleDiscPanel()
})
document.querySelectorAll('.d-item').forEach(el => {
  el.addEventListener('click', () => selectDiscipline(el.dataset.discipline))
})

// Close on outside click (the movement filter has its own handler already;
// we add a separate one for the discipline panel)
document.addEventListener('click', e => {
  if (!e.target.closest('#discipline-wrap')) toggleDiscPanel(false)
})

window.addEventListener('resize', () => {
  if (!discPanel.hidden) positionDiscPanel()
})

// Populate counts in the dropdown from the loaded data
function populateDisciplineCounts() {
  const total = nodes.length
  const p = nodes.filter(n => n.disciplines?.includes('painter')).length
  const s = nodes.filter(n => n.disciplines?.includes('sculptor')).length
  const a = nodes.filter(n => n.disciplines?.includes('architect')).length
  document.getElementById('d-count-all').textContent       = total.toLocaleString()
  document.getElementById('d-count-painter').textContent   = p.toLocaleString()
  document.getElementById('d-count-sculptor').textContent  = s.toLocaleString()
  document.getElementById('d-count-architect').textContent = a.toLocaleString()
}
canvasWrap.addEventListener('mousemove', e => {
  mouseX = e.clientX; mouseY = e.clientY
  if (showLabels && hoveredIdx >= 0) renderTooltip(hoveredIdx, mouseX, mouseY)
})
canvasWrap.addEventListener('mouseleave', hideTooltip)
document.addEventListener('click', e => {
  if (!e.target.closest('#search-wrap') && !e.target.closest('#search-results'))
    searchResults.hidden = true
})

// Panel collapse toggle
const panelToggle = document.getElementById('panel-toggle')
const appEl       = document.getElementById('app')
panelToggle.addEventListener('click', () => {
  const collapsed = appEl.classList.toggle('panel-collapsed')
  panelToggle.setAttribute('aria-expanded', String(!collapsed))
  // Close any open dropdowns when collapsing — they would otherwise dangle in space
  if (collapsed) {
    searchResults.hidden = true
    if (typeof toggleFilterPanel === 'function') toggleFilterPanel(false)
    if (typeof toggleDiscPanel   === 'function') toggleDiscPanel(false)
  }
})

// ── Movement filter ─────────────────────────────────────────────
function buildFilterList(query = '') {
  filterList.innerHTML = ''
  const q = query.trim().toLowerCase()
  const items = movementsManifest.filter(m => !q || m.name.toLowerCase().includes(q))

  // 'Show all' option always first
  const all = document.createElement('div')
  all.className = 'f-item all' + (selectedMovement === null ? ' selected' : '')
  all.innerHTML = `<span class="f-name">All movements</span><span class="f-count">${nodes.length}</span>`
  all.addEventListener('click', () => selectMovement(null))
  filterList.appendChild(all)

  // Movement items
  items.forEach(m => {
    const el = document.createElement('div')
    el.className = 'f-item' + (selectedMovement === m.name ? ' selected' : '')
    el.innerHTML =
      `<span class="f-name">${m.name}</span>` +
      `<span class="f-count">` +
        (m.century ? `<span class="f-cent">${m.century}th</span>` : '') +
        `${m.count}` +
      `</span>`
    el.addEventListener('click', () => selectMovement(m.name))
    filterList.appendChild(el)
  })
}

function positionFilterPanel() {
  const r = filterBtn.getBoundingClientRect()
  filterPanel.style.top  = `${r.bottom + 4}px`
  filterPanel.style.left = `${r.left}px`
}

function toggleFilterPanel(open) {
  const isOpen = open ?? filterPanel.hidden
  if (isOpen) {
    positionFilterPanel()
    buildFilterList(filterSearch.value)
    filterPanel.hidden = false
    filterBtn.setAttribute('aria-expanded', 'true')
    filterSearch.focus()
  } else {
    filterPanel.hidden = true
    filterBtn.setAttribute('aria-expanded', 'false')
    filterSearch.value = ''
  }
}

function selectMovement(movementName) {
  selectedMovement = movementName
  filterLabel.textContent = movementName ?? 'All movements'
  filterBtn.classList.toggle('active', movementName !== null)
  toggleFilterPanel(false)
  applyMovementFilter()
}

// Combined visual filter — handles both movement filter and search focus.
// A node is "bright" if it matches the current movement filter (if any)
// AND is either the focused node, a direct neighbour, or no focus is set.
function applyVisualFilter() {
  if (!graph) return
  const N = nodes.length
  const L = linkPairs.length

  const movementMatch   = (n) => !selectedMovement || n.movements?.includes(selectedMovement)
  const focusMatch      = (idx) => focusedNodeIdx < 0 || idx === focusedNodeIdx || focusedNeighbours?.has(idx)
  const disciplineMatch = (n) => selectedDiscipline === 'all' || n.disciplines?.includes(selectedDiscipline)

  const nodeIsBright = (n, idx) => movementMatch(n) && focusMatch(idx) && disciplineMatch(n)

  // Point colors
  const pointColors = new Float32Array(N * 4)
  for (let i = 0; i < N; i++) {
    const [r, g, b] = hexToRgb(nodeColor(nodes[i], i, N, currentLayout))
    const bright = nodeIsBright(nodes[i], i)
    pointColors[i * 4]     = r
    pointColors[i * 4 + 1] = g
    pointColors[i * 4 + 2] = b
    pointColors[i * 4 + 3] = bright ? 0.9 : 0.08
  }
  graph.setPointColors(pointColors)

  // Link colors — bright only if BOTH endpoints are bright
  // Special-case the focused node's links: keep ALL of them bright in yellow
  // so the focus's connections are unmistakable.
  const linkColors = new Float32Array(L * 4)
  for (let i = 0; i < L; i++) {
    const [a, b] = linkPairs[i]
    const touchesFocus = focusedNodeIdx >= 0 && (a === focusedNodeIdx || b === focusedNodeIdx)
    const bothBright   = nodeIsBright(nodes[a], a) && nodeIsBright(nodes[b], b)

    if (touchesFocus) {
      // Highlight the focused node's own edges in yellow
      linkColors[i * 4]     = 0.98
      linkColors[i * 4 + 1] = 0.80
      linkColors[i * 4 + 2] = 0.13
      linkColors[i * 4 + 3] = 0.85
    } else {
      linkColors[i * 4]     = 0.65
      linkColors[i * 4 + 1] = 0.70
      linkColors[i * 4 + 2] = 0.80
      linkColors[i * 4 + 3] = bothBright ? 0.8 : 0.04
    }
  }
  graph.setLinkColors(linkColors)

  graph.render()
}

// Kept as alias for the movement filter UI which still calls applyMovementFilter()
const applyMovementFilter = applyVisualFilter

filterBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  toggleFilterPanel()
})
filterSearch.addEventListener('input', () => buildFilterList(filterSearch.value))
filterSearch.addEventListener('keydown', e => {
  if (e.key === 'Escape') toggleFilterPanel(false)
})

// Close filter when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('#filter-wrap')) toggleFilterPanel(false)
})

window.addEventListener('resize', () => {
  if (!filterPanel.hidden) positionFilterPanel()
})

// ── Boot ──────────────────────────────────────────────────────────
;(async () => {
  try {
    await loadData()
    populateDisciplineCounts()
    loadBadge.classList.add('hidden')
    switchLayout('force')
  } catch (err) {
    console.error('Failed to load data:', err)
    loadBadge.textContent = 'Error loading data'
  }
})()

function hexToRgb(hex) {
  const h    = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  const n    = parseInt(full, 16)
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]
}

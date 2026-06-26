import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { TUNING } from '../plane/flight'
import { PAL } from '../art/palette'

/**
 * Hud.ts — the cozy, premium overlay HUD.
 *
 * Builds a pure-DOM overlay into ctx.hud.root (which is already
 * position:fixed; inset:0; pointer-events:none). Everything here is a child of
 * that root, so it inherits the no-pointer-events behaviour and never steals
 * touches from the canvas. Everything sits inside iOS safe-area insets.
 *
 * Widgets (all read-only on shared state — the HUD never mutates game state):
 *
 *   TOP-LEFT  — XP RING + level badge (animated stroke that fills clockwise; a
 *               soft pulse fires on `levelup`). Reads (ctx as any).progress
 *               ({ xp, level, xpToNext }) published by Progression.ts. Under it,
 *               a SPEED bar + numeric readout and an ALTITUDE readout with a
 *               climb/dive arrow, both from ctx.player.flight.
 *
 *   TOP-CENTER (under the ring cluster) — a polished BOOST METER: a pill that
 *               drains while boosting and refills when idle. The on/off truth is
 *               (ctx as any).boostActive (Boost.ts's authoritative flag, with
 *               fallbacks); the *level* is modelled here read-only using the
 *               same drain/regen rates as Boost.ts so the bar tracks it without
 *               reading private state or touching another file.
 *
 *   TOP-RIGHT — COLLECTIBLE COUNT chips with icons, one per type; each chip
 *               "pops" briefly when its count ticks up (driven off `collect`).
 *
 *   BOTTOM-RIGHT — MINIMAP: planet disc with a faint terrain-hint texture, a
 *               range ring, an altitude band ring, the centered player heading
 *               wedge (north == forward), nearby collectible blips
 *               ((ctx as any).collectibleDirs) and landmark diamonds
 *               ((ctx as any).landmarks → { dir|position }).
 *
 *   TOP-CENTER (top of screen) — QUEST TRACKER: live from `questStart` /
 *               `questProgress` / `questComplete` events. Shows the active
 *               quest label + stage/step, ticking out when completed.
 *
 *   BOTTOM-LEFT — CONTROL HINTS, shown briefly then faded.
 *
 * Perf contract: ZERO allocation in update(). Every DOM write is guarded by a
 * cached "last value" so we only touch the DOM (text / attribute / transform)
 * when something actually changed. The minimap is redrawn on a throttle
 * (~14 fps) into a tiny device-pixel-aware canvas. All vector math reuses
 * module-scoped temps. No Three.js objects are added to the scene.
 */

// ---- module-scoped temps (reused every frame; never allocated in update) ----
const _up = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _north = new THREE.Vector3()
const _east = new THREE.Vector3()
const _dir = new THREE.Vector3()

// CSS color helpers — called only at build time.
const hex = (c: THREE.Color): string => '#' + c.getHexString()
const rgba = (c: THREE.Color, a: number): string => {
  const r = Math.round(THREE.MathUtils.clamp(c.r, 0, 1) * 255)
  const g = Math.round(THREE.MathUtils.clamp(c.g, 0, 1) * 255)
  const b = Math.round(THREE.MathUtils.clamp(c.b, 0, 1) * 255)
  return `rgba(${r},${g},${b},${a})`
}

// Minimap geometry (small & device-pixel-aware for crisp mobile dots).
const MAP_CSS = 92 // css px (square)
const MAP_THROTTLE = 1 / 14 // seconds between minimap redraws
const MAP_RANGE = 72 // world units around the player shown on the map
const MAX_BLIPS = 24 // cap drawn collectible blips (mobile-friendly)
const MAX_LANDMARKS = 8 // cap drawn landmark diamonds

// Boost meter model — MUST mirror Boost.ts so the bar reads true without
// reaching into private state. Boost.ts: DRAIN 0.42/s, REGEN 0.22/s, a regen
// delay, then a faster regen tail. We approximate the same envelope here.
const BOOST_DRAIN = 0.42
const BOOST_REGEN = 0.22
const BOOST_REGEN_DELAY = 0.5
const BOOST_REGEN_FAST = 1.4

type CountType = 'box' | 'diamond' | 'lantern' | 'ring'
const COUNT_TYPES: CountType[] = ['box', 'diamond', 'lantern', 'ring']
const COUNT_ICON: Record<CountType, string> = {
  box: '▣',
  diamond: '◆',
  lantern: '✦',
  ring: '◯',
}
const COUNT_LABEL: Record<CountType, string> = {
  box: 'crates',
  diamond: 'gems',
  lantern: 'lanterns',
  ring: 'rings',
}

export function createHudSystem(): GameSystem {
  // ---- DOM handles (built in init) ----
  let layer: HTMLDivElement | null = null
  let ringFg: SVGCircleElement | null = null
  let ringWrap: HTMLDivElement | null = null
  let lvlText: HTMLDivElement | null = null
  let speedText: HTMLSpanElement | null = null
  let speedFill: HTMLDivElement | null = null
  let altText: HTMLSpanElement | null = null
  let altArrow: HTMLSpanElement | null = null
  let boostFill: HTMLDivElement | null = null
  let boostPill: HTMLDivElement | null = null
  let hints: HTMLDivElement | null = null
  let questWrap: HTMLDivElement | null = null
  let questTitle: HTMLSpanElement | null = null
  let questStep: HTMLSpanElement | null = null
  const countChips: Partial<Record<CountType, HTMLDivElement>> = {}
  const countEls: Partial<Record<CountType, HTMLSpanElement>> = {}

  // minimap
  let mapCanvas: HTMLCanvasElement | null = null
  let mapCtx: CanvasRenderingContext2D | null = null
  let mapPx = MAP_CSS // backing-store size (css * dpr)

  // event teardown
  let offCollect: (() => void) | null = null
  let offLevel: (() => void) | null = null
  let offQStart: (() => void) | null = null
  let offQProg: (() => void) | null = null
  let offQDone: (() => void) | null = null

  // ---- cached "last rendered" values (so we only write DOM on change) ----
  const counts: Record<CountType, number> = { box: 0, diamond: 0, lantern: 0, ring: 0 }
  const shownCounts: Record<CountType, number> = { box: -1, diamond: -1, lantern: -1, ring: -1 }
  const popTimer: Record<CountType, number> = { box: 0, diamond: 0, lantern: 0, ring: 0 }
  const popArmed: Record<CountType, boolean> = { box: false, diamond: false, lantern: false, ring: false }
  let shownLevel = -1
  let shownSpeed = -1
  let shownSpeedFrac = -1
  let shownAlt = -999
  let shownAltSign = 2 // -1 dive, 0 level, 1 climb, 2 = uninit
  let lastAlt = 0
  let shownRingFrac = -1
  let shownBoost: boolean | null = null
  let shownBoostFrac = -1
  let boostMeter = 1 // read-only mirror of Boost.ts's charge (starts full)
  let sinceBoost = 999 // seconds since boost released (for regen-delay model)
  let mapAccum = 0
  let hintsTimer = 0
  let hintsFaded = false
  let levelPulse = 0 // seconds remaining on the level-up ring pulse

  // ---- quest tracker state (driven by events; rendered in update) ----
  let questId: string | null = null
  let questLabel = ''
  let questStepText = ''
  let questDirty = false // a string field changed; flush in update()
  let questVisible = false
  let questHideTimer = 0 // >0 while showing the "complete" flourish before hiding
  let shownQuestLabel = ''
  let shownQuestStep = ''
  let shownQuestVisible = false

  // precomputed ring geometry (circumference) so update() does no math beyond a lerp
  const RING_R = 23
  const RING_CIRC = 2 * Math.PI * RING_R

  // cached css colors (computed once)
  const C_RING = hex(PAL.gem)
  const C_RING_TRACK = 'rgba(255,255,255,0.16)'
  const C_CORAL = hex(PAL.planeBody)
  const C_WING = hex(PAL.planeWing)
  const C_GEM = hex(PAL.gem)
  const C_SUN = hex(PAL.sun)
  const C_PLANET = hex(PAL.planet)
  const C_TREE = hex(PAL.tree)
  const C_SKY = hex(PAL.skyHorizon)
  const C_PLANET_WASH = rgba(PAL.planet, 0.2)
  const C_TERRAIN_HINT = rgba(PAL.tree, 0.22)

  const chipAccent: Record<CountType, string> = {
    box: C_WING,
    diamond: C_GEM,
    lantern: C_SUN,
    ring: C_SKY,
  }

  // ---- event handlers (mutate small state only; no DOM writes here) ----
  function onCollect(payload?: any) {
    const t = payload && payload.type
    if (t === 'box' || t === 'diamond' || t === 'lantern' || t === 'ring') {
      counts[t as CountType] += 1
      popTimer[t as CountType] = 0.32 // trigger a pop on next update()
      popArmed[t as CountType] = true // (re)arm so a fresh collect always re-pops
    }
  }
  function onLevelUp() {
    levelPulse = 0.9
  }
  function questStepFrom(p: any): string {
    if (!p) return ''
    if (typeof p.current === 'number' && typeof p.total === 'number') {
      return `${Math.max(0, p.current)} / ${p.total}`
    }
    if (typeof p.stage === 'string' && p.stage.length) {
      return p.stage.charAt(0).toUpperCase() + p.stage.slice(1)
    }
    if (typeof p.kind === 'string' && p.kind.length) return p.kind
    return ''
  }
  function onQuestStart(p?: any) {
    questId = (p && (p.id as string)) || 'quest'
    questLabel = (p && (p.label as string)) || 'New Quest'
    questStepText = questStepFrom(p)
    questVisible = true
    questHideTimer = 0
    questDirty = true
  }
  function onQuestProgress(p?: any) {
    const id = (p && (p.id as string)) || questId
    if (id !== questId) {
      // a different quest started reporting — adopt it
      questId = id
      if (p && p.label) questLabel = p.label as string
    }
    const step = questStepFrom(p)
    questStepText = step
    questVisible = true
    questHideTimer = 0
    questDirty = true
  }
  function onQuestComplete(p?: any) {
    const id = (p && (p.id as string)) || questId
    // Only react if it matches the tracked quest (or we have none).
    if (questId && id !== questId) return
    questLabel = (p && (p.label as string)) || questLabel || 'Quest'
    questStepText = '✓ Complete'
    questVisible = true
    questHideTimer = 2.2 // show the flourish, then fade
    questDirty = true
  }

  // ---- minimap draw (throttled; reuses temps, allocates nothing) ----
  function drawMap(ctx: GameContext) {
    const g = mapCtx
    if (!g || !mapCanvas) return
    const px = mapPx
    const cx = px * 0.5
    const cy = px * 0.5
    const rDisc = px * 0.5 - 2

    g.clearRect(0, 0, px, px)

    // clip everything to the disc so blips never spill past the bezel
    g.save()
    g.beginPath()
    g.arc(cx, cy, rDisc, 0, Math.PI * 2)
    g.clip()

    // planet disc wash
    g.fillStyle = C_PLANET_WASH
    g.fillRect(0, 0, px, px)

    // faint terrain-hint speckle (static dot grid → reads as "land texture"
    // without per-pixel noise). Cheap: a handful of soft dots.
    g.fillStyle = C_TERRAIN_HINT
    const step = px * 0.14
    const r = px * 0.013
    for (let yy = step * 0.5; yy < px; yy += step) {
      for (let xx = step * 0.5; xx < px; xx += step) {
        // offset alternate rows for an organic look
        const ox = ((Math.floor(yy / step) & 1) ? step * 0.5 : 0)
        g.beginPath()
        g.arc(xx + ox, yy, r, 0, Math.PI * 2)
        g.fill()
      }
    }

    g.restore()

    // build a local tangent frame at the player so we can project nearby
    // surface directions into the minimap plane (north = forward heading).
    _up.copy(ctx.player.obj.position).normalize()
    _fwd.set(0, 0, 1).applyQuaternion(ctx.player.obj.quaternion)
    _north.copy(_fwd).addScaledVector(_up, -_fwd.dot(_up))
    if (_north.lengthSq() < 1e-6) _north.set(1, 0, 0).addScaledVector(_up, -_up.x)
    _north.normalize()
    _east.crossVectors(_up, _north).normalize() // right-hand: east points map-right

    const playerPos = ctx.player.obj.position
    const scale = rDisc / MAP_RANGE

    // landmark diamonds (warm sun) — read from the published registry
    const lms = (ctx as any).landmarks as Array<any> | undefined
    if (lms && lms.length) {
      const n = Math.min(lms.length, MAX_LANDMARKS)
      g.fillStyle = C_SUN
      for (let i = 0; i < n; i++) {
        const lm = lms[i]
        if (!lm) continue
        const d = lm.dir as THREE.Vector3 | undefined
        const pos = lm.position as THREE.Vector3 | undefined
        if (d) _dir.copy(d).multiplyScalar(ctx.planet.radius)
        else if (pos) _dir.copy(pos)
        else continue
        _dir.sub(playerPos)
        const ex = _dir.dot(_east)
        const ny = _dir.dot(_north)
        // landmarks are far — clamp them to the rim as a bearing pointer
        let sx = cx + ex * scale
        let sy = cy - ny * scale
        const dx = sx - cx
        const dy = sy - cy
        const dist = Math.hypot(dx, dy)
        const rim = rDisc - px * 0.05
        if (dist > rim) {
          const k = rim / (dist || 1)
          sx = cx + dx * k
          sy = cy + dy * k
        }
        const ds = Math.max(2, px * 0.03)
        g.save()
        g.translate(sx, sy)
        g.rotate(Math.PI / 4)
        g.fillRect(-ds, -ds, ds * 2, ds * 2)
        g.restore()
      }
    }

    // nearby collectible blips (unit surface dirs), if published
    const dirs = (ctx as any).collectibleDirs as THREE.Vector3[] | undefined
    if (dirs && dirs.length) {
      const n = Math.min(dirs.length, MAX_BLIPS)
      g.fillStyle = C_GEM
      for (let i = 0; i < n; i++) {
        const d = dirs[i]
        if (!d) continue
        _dir.copy(d).multiplyScalar(ctx.planet.radius)
        _dir.sub(playerPos)
        const ex = _dir.dot(_east)
        const ny = _dir.dot(_north)
        const horiz = Math.hypot(ex, ny)
        if (horiz > MAP_RANGE) continue
        const sx = cx + ex * scale
        const sy = cy - ny * scale
        g.beginPath()
        g.arc(sx, sy, Math.max(1.3, px * 0.022), 0, Math.PI * 2)
        g.fill()
      }
    }

    // range ring (where the map "edge" is in world units)
    g.beginPath()
    g.arc(cx, cy, rDisc * 0.92, 0, Math.PI * 2)
    g.strokeStyle = C_PLANET
    g.globalAlpha = 0.28
    g.lineWidth = 1
    g.stroke()
    g.globalAlpha = 1

    // altitude band: a soft ring whose radius hints at altitude
    const altFrac = THREE.MathUtils.clamp(
      ctx.player.flight.altitude / TUNING.MAX_ALTITUDE,
      0,
      1,
    )
    g.beginPath()
    g.arc(cx, cy, rDisc * (0.16 + altFrac * 0.18), 0, Math.PI * 2)
    g.strokeStyle = C_SKY
    g.globalAlpha = 0.32
    g.lineWidth = 1.5
    g.stroke()
    g.globalAlpha = 1

    // player heading wedge — always centered; the world scrolls under it. The
    // plane is the only coral object, so keep the wedge coral.
    const wedge = px * 0.12
    g.save()
    g.translate(cx, cy)
    g.beginPath()
    g.moveTo(0, -wedge)
    g.lineTo(wedge * 0.62, wedge * 0.7)
    g.lineTo(0, wedge * 0.34)
    g.lineTo(-wedge * 0.62, wedge * 0.7)
    g.closePath()
    g.fillStyle = C_CORAL
    g.shadowColor = C_CORAL
    g.shadowBlur = px * 0.07
    g.fill()
    g.restore()
    g.shadowBlur = 0

    // crisp bezel ring on top
    g.beginPath()
    g.arc(cx, cy, rDisc, 0, Math.PI * 2)
    g.lineWidth = Math.max(1, px * 0.012)
    g.strokeStyle = C_PLANET
    g.globalAlpha = 0.75
    g.stroke()
    g.globalAlpha = 1
  }

  return {
    name: 'hud',

    init(ctx: GameContext) {
      const root = ctx.hud.root

      // A dedicated sub-layer so we own a clean stacking context and can tear
      // down everything at once. Inherits pointer-events:none from #hud.
      const el = document.createElement('div')
      el.id = 'hud-core'
      el.style.cssText = [
        'position:absolute',
        'inset:0',
        'pointer-events:none',
        'font-family:system-ui,-apple-system,sans-serif',
        'color:#fff',
        '-webkit-user-select:none',
        'user-select:none',
      ].join(';')
      layer = el
      root.appendChild(el)

      // keyframes for chip pops + boost shimmer (scoped, injected once)
      const style = document.createElement('style')
      style.textContent = [
        '@keyframes hud-pop{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}',
        '@keyframes hud-quest-in{0%{opacity:0;transform:translate(-50%,-8px)}100%{opacity:1;transform:translate(-50%,0)}}',
      ].join('')
      el.appendChild(style)

      // ---------- TOP-LEFT cluster: XP ring + level + readouts ----------
      const tl = document.createElement('div')
      tl.style.cssText = [
        'position:absolute',
        'top:calc(env(safe-area-inset-top,0px) + 12px)',
        'left:calc(env(safe-area-inset-left,0px) + 12px)',
        'display:flex',
        'align-items:flex-start',
        'gap:11px',
      ].join(';')
      el.appendChild(tl)

      // XP ring (inline SVG). Track + animated foreground with a gradient.
      const SVG = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(SVG, 'svg')
      const dim = (RING_R + 7) * 2
      svg.setAttribute('width', String(dim))
      svg.setAttribute('height', String(dim))
      svg.setAttribute('viewBox', `0 0 ${dim} ${dim}`)
      svg.style.cssText =
        'filter:drop-shadow(0 2px 5px rgba(0,0,0,.45));flex:0 0 auto;transition:transform .25s cubic-bezier(.2,1.4,.5,1)'

      // gradient def for the XP stroke (gem → wing, a cozy aurora sweep)
      const defs = document.createElementNS(SVG, 'defs')
      const grad = document.createElementNS(SVG, 'linearGradient')
      grad.setAttribute('id', 'hud-xp-grad')
      grad.setAttribute('x1', '0%')
      grad.setAttribute('y1', '0%')
      grad.setAttribute('x2', '100%')
      grad.setAttribute('y2', '100%')
      const s0 = document.createElementNS(SVG, 'stop')
      s0.setAttribute('offset', '0%')
      s0.setAttribute('stop-color', C_GEM)
      const s1 = document.createElementNS(SVG, 'stop')
      s1.setAttribute('offset', '100%')
      s1.setAttribute('stop-color', C_WING)
      grad.appendChild(s0)
      grad.appendChild(s1)
      defs.appendChild(grad)
      svg.appendChild(defs)

      const cxy = dim / 2
      const track = document.createElementNS(SVG, 'circle')
      track.setAttribute('cx', String(cxy))
      track.setAttribute('cy', String(cxy))
      track.setAttribute('r', String(RING_R))
      track.setAttribute('fill', 'rgba(10,16,34,.34)')
      track.setAttribute('stroke', C_RING_TRACK)
      track.setAttribute('stroke-width', '5')
      svg.appendChild(track)

      const fg = document.createElementNS(SVG, 'circle')
      fg.setAttribute('cx', String(cxy))
      fg.setAttribute('cy', String(cxy))
      fg.setAttribute('r', String(RING_R))
      fg.setAttribute('fill', 'none')
      fg.setAttribute('stroke', 'url(#hud-xp-grad)')
      fg.setAttribute('stroke-width', '5')
      fg.setAttribute('stroke-linecap', 'round')
      fg.setAttribute('stroke-dasharray', String(RING_CIRC))
      fg.setAttribute('stroke-dashoffset', String(RING_CIRC)) // start empty
      fg.setAttribute('transform', `rotate(-90 ${cxy} ${cxy})`)
      fg.style.transition = 'stroke-dashoffset .25s ease'
      svg.appendChild(fg)
      ringFg = fg

      // level number sits inside the ring
      const wrap = document.createElement('div')
      wrap.style.cssText = 'position:relative;flex:0 0 auto'
      wrap.appendChild(svg)
      ringWrap = svg as unknown as HTMLDivElement // we pulse the <svg>'s transform
      const lvlCol = document.createElement('div')
      lvlCol.style.cssText = [
        'position:absolute',
        'inset:0',
        'display:flex',
        'flex-direction:column',
        'align-items:center',
        'justify-content:center',
        'gap:0',
      ].join(';')
      const lvlTag = document.createElement('div')
      lvlTag.style.cssText =
        'font-size:8px;font-weight:700;letter-spacing:1.2px;opacity:.7;line-height:1'
      lvlTag.textContent = 'LVL'
      const lvl = document.createElement('div')
      lvl.style.cssText = [
        'font-size:19px',
        'font-weight:800',
        'line-height:1',
        'text-shadow:0 1px 3px rgba(0,0,0,.6)',
      ].join(';')
      lvl.textContent = '1'
      lvlCol.appendChild(lvlTag)
      lvlCol.appendChild(lvl)
      wrap.appendChild(lvlCol)
      lvlText = lvl
      tl.appendChild(wrap)

      // readouts column (speed bar / altitude) + boost meter
      const col = document.createElement('div')
      col.style.cssText =
        'display:flex;flex-direction:column;gap:6px;margin-top:2px;text-shadow:0 1px 3px rgba(0,0,0,.55)'
      tl.appendChild(col)

      // SPEED: numeric + a thin fill bar
      const spdRow = document.createElement('div')
      spdRow.style.cssText = 'display:flex;align-items:baseline;gap:5px;font-weight:700;line-height:1'
      const spdVal = document.createElement('span')
      spdVal.style.cssText = `font-size:18px;color:${C_WING};min-width:30px`
      spdVal.textContent = '0'
      const spdUnit = document.createElement('span')
      spdUnit.style.cssText = 'font-size:10px;opacity:.72;font-weight:600;letter-spacing:.3px'
      spdUnit.textContent = 'SPD'
      spdRow.appendChild(spdVal)
      spdRow.appendChild(spdUnit)
      col.appendChild(spdRow)
      speedText = spdVal

      const spdTrack = document.createElement('div')
      spdTrack.style.cssText = [
        'width:74px',
        'height:4px',
        'border-radius:3px',
        'background:rgba(255,255,255,.16)',
        'overflow:hidden',
        'margin-top:-1px',
      ].join(';')
      const spdFill = document.createElement('div')
      spdFill.style.cssText = [
        'height:100%',
        'width:0%',
        `background:linear-gradient(90deg,${C_WING},${C_CORAL})`,
        'border-radius:3px',
        'transition:width .12s linear',
      ].join(';')
      spdTrack.appendChild(spdFill)
      col.appendChild(spdTrack)
      speedFill = spdFill

      // ALTITUDE: numeric + climb/dive arrow
      const altRow = document.createElement('div')
      altRow.style.cssText =
        'display:flex;align-items:baseline;gap:5px;font-weight:700;line-height:1;margin-top:1px'
      const altVal = document.createElement('span')
      altVal.style.cssText = `font-size:18px;color:${C_SKY};min-width:30px`
      altVal.textContent = '0'
      const altUnit = document.createElement('span')
      altUnit.style.cssText = 'font-size:10px;opacity:.72;font-weight:600;letter-spacing:.3px'
      altUnit.textContent = 'ALT'
      const altArr = document.createElement('span')
      altArr.style.cssText = 'font-size:11px;font-weight:800;opacity:.85'
      altArr.textContent = '–'
      altRow.appendChild(altVal)
      altRow.appendChild(altUnit)
      altRow.appendChild(altArr)
      col.appendChild(altRow)
      altText = altVal
      altArrow = altArr

      // BOOST METER — a polished pill bar (drains while boosting)
      const bWrap = document.createElement('div')
      bWrap.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:6px',
        'margin-top:3px',
      ].join(';')
      const bIcon = document.createElement('span')
      bIcon.style.cssText = `font-size:11px;color:${C_WING};font-weight:800`
      bIcon.textContent = '⚡'
      const bTrack = document.createElement('div')
      bTrack.style.cssText = [
        'position:relative',
        'width:74px',
        'height:8px',
        'border-radius:5px',
        'background:rgba(10,16,34,.42)',
        'box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)',
        'overflow:hidden',
        'transition:box-shadow .18s ease',
      ].join(';')
      const bFill = document.createElement('div')
      bFill.style.cssText = [
        'height:100%',
        'width:100%',
        `background:linear-gradient(90deg,${C_WING},${C_CORAL})`,
        'border-radius:5px',
        'transform-origin:left center',
      ].join(';')
      bTrack.appendChild(bFill)
      bWrap.appendChild(bIcon)
      bWrap.appendChild(bTrack)
      col.appendChild(bWrap)
      boostFill = bFill
      boostPill = bTrack

      // ---------- TOP-CENTER: quest tracker ----------
      const q = document.createElement('div')
      q.style.cssText = [
        'position:absolute',
        'top:calc(env(safe-area-inset-top,0px) + 12px)',
        'left:50%',
        'transform:translate(-50%,0)',
        'display:flex',
        'align-items:center',
        'gap:8px',
        'padding:6px 13px',
        'border-radius:13px',
        'background:rgba(10,16,34,.46)',
        'backdrop-filter:blur(3px)',
        '-webkit-backdrop-filter:blur(3px)',
        'box-shadow:0 2px 10px rgba(0,0,0,.32),inset 0 0 0 1px rgba(255,255,255,.10)',
        'max-width:64vw',
        'opacity:0',
        'transition:opacity .4s ease',
        'pointer-events:none',
      ].join(';')
      const qIcon = document.createElement('span')
      qIcon.style.cssText = `font-size:13px;color:${C_SUN}`
      qIcon.textContent = '✦'
      const qTitle = document.createElement('span')
      qTitle.style.cssText =
        'font-size:12px;font-weight:800;letter-spacing:.2px;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.5)'
      qTitle.textContent = ''
      const qStep = document.createElement('span')
      qStep.style.cssText = `font-size:11px;font-weight:700;color:${C_GEM};opacity:.95`
      qStep.textContent = ''
      q.appendChild(qIcon)
      q.appendChild(qTitle)
      q.appendChild(qStep)
      el.appendChild(q)
      questWrap = q
      questTitle = qTitle
      questStep = qStep

      // ---------- TOP-RIGHT: collectible count chips ----------
      const tr = document.createElement('div')
      tr.style.cssText = [
        'position:absolute',
        'top:calc(env(safe-area-inset-top,0px) + 12px)',
        'right:calc(env(safe-area-inset-right,0px) + 12px)',
        'display:flex',
        'flex-direction:column',
        'gap:6px',
        'align-items:flex-end',
      ].join(';')
      el.appendChild(tr)

      for (let i = 0; i < COUNT_TYPES.length; i++) {
        const t = COUNT_TYPES[i]
        const chip = document.createElement('div')
        chip.title = COUNT_LABEL[t]
        chip.style.cssText = [
          'display:flex',
          'align-items:center',
          'gap:6px',
          'padding:3px 10px 3px 8px',
          'border-radius:11px',
          'background:rgba(10,16,34,.42)',
          'backdrop-filter:blur(2px)',
          '-webkit-backdrop-filter:blur(2px)',
          'box-shadow:0 1px 4px rgba(0,0,0,.28),inset 0 0 0 1px rgba(255,255,255,.07)',
          'font-weight:700',
          'text-shadow:0 1px 2px rgba(0,0,0,.5)',
          'will-change:transform',
        ].join(';')
        const icon = document.createElement('span')
        icon.textContent = COUNT_ICON[t]
        icon.style.cssText = `font-size:13px;color:${chipAccent[t]}`
        const num = document.createElement('span')
        num.textContent = '0'
        num.style.cssText = 'font-size:13px;min-width:13px;text-align:right;font-variant-numeric:tabular-nums'
        chip.appendChild(icon)
        chip.appendChild(num)
        tr.appendChild(chip)
        countChips[t] = chip
        countEls[t] = num
      }

      // ---------- BOTTOM-RIGHT: minimap ----------
      const dpr = Math.min(window.devicePixelRatio || 1, 2) // cap dpr for perf
      mapPx = Math.round(MAP_CSS * dpr)
      const canvas = document.createElement('canvas')
      canvas.width = mapPx
      canvas.height = mapPx
      canvas.style.cssText = [
        'position:absolute',
        'bottom:calc(env(safe-area-inset-bottom,0px) + 14px)',
        'right:calc(env(safe-area-inset-right,0px) + 12px)',
        `width:${MAP_CSS}px`,
        `height:${MAP_CSS}px`,
        'border-radius:50%',
        'background:rgba(8,12,28,.40)',
        'box-shadow:0 3px 12px rgba(0,0,0,.38),inset 0 0 0 1px rgba(255,255,255,.10)',
      ].join(';')
      el.appendChild(canvas)
      mapCanvas = canvas
      mapCtx = canvas.getContext('2d')

      // ---------- BOTTOM-LEFT: control hints (fade after a few seconds) ----------
      const hint = document.createElement('div')
      hint.style.cssText = [
        'position:absolute',
        'bottom:calc(env(safe-area-inset-bottom,0px) + 16px)',
        'left:calc(env(safe-area-inset-left,0px) + 14px)',
        'font-size:11px',
        'line-height:1.7',
        'font-weight:600',
        'opacity:.82',
        'text-shadow:0 1px 3px rgba(0,0,0,.6)',
        'transition:opacity 1s ease',
        'max-width:46vw',
      ].join(';')
      hint.innerHTML =
        '<b>W/S</b> pitch &nbsp; <b>A/D</b> bank &nbsp; <b>Shift</b> boost &nbsp; <b>Space</b> roll'
      el.appendChild(hint)
      hints = hint
      hintsTimer = 0
      hintsFaded = false

      offCollect = ctx.events.on('collect', onCollect)
      offLevel = ctx.events.on('levelup', onLevelUp)
      offQStart = ctx.events.on('questStart', onQuestStart)
      offQProg = ctx.events.on('questProgress', onQuestProgress)
      offQDone = ctx.events.on('questComplete', onQuestComplete)
    },

    update(dt: number, ctx: GameContext) {
      // ---- level + XP ring (read the shared Progression readout) ----
      const prog = (ctx as any).progress as
        | { xp: number; level: number; xpToNext: number }
        | undefined
      if (prog) {
        if (prog.level !== shownLevel) {
          shownLevel = prog.level
          if (lvlText) lvlText.textContent = String(prog.level)
        }
        const denom = prog.xpToNext > 0 ? prog.xpToNext : 1
        const frac = Math.round(THREE.MathUtils.clamp(prog.xp / denom, 0, 1) * 100) / 100
        if (frac !== shownRingFrac) {
          shownRingFrac = frac
          if (ringFg) {
            ringFg.setAttribute('stroke-dashoffset', String(RING_CIRC * (1 - frac)))
          }
        }
      }

      // ---- level-up ring pulse (scale the svg via transform; GPU-composited) ----
      if (levelPulse > 0 && ringWrap) {
        levelPulse = Math.max(0, levelPulse - dt)
        // ease back to 1 over the pulse window
        const k = levelPulse / 0.9 // 1 → 0
        const s = 1 + 0.16 * Math.sin(k * Math.PI) // bump in the middle
        ;(ringWrap as unknown as SVGElement).style.transform = `scale(${s.toFixed(3)})`
        if (levelPulse === 0) (ringWrap as unknown as SVGElement).style.transform = 'scale(1)'
      }

      // ---- speed (number + fill bar relative to boost top speed) ----
      const flight = ctx.player.flight
      const spd = Math.round(flight.speed)
      if (spd !== shownSpeed) {
        shownSpeed = spd
        if (speedText) speedText.textContent = String(spd)
      }
      const spdFrac =
        Math.round(THREE.MathUtils.clamp(flight.speed / TUNING.BOOST_SPEED, 0, 1) * 100) / 100
      if (spdFrac !== shownSpeedFrac) {
        shownSpeedFrac = spdFrac
        if (speedFill) speedFill.style.width = `${(spdFrac * 100).toFixed(0)}%`
      }

      // ---- altitude (number + climb/dive arrow) ----
      const alt = Math.round(flight.altitude)
      if (alt !== shownAlt) {
        shownAlt = alt
        if (altText) altText.textContent = String(alt)
      }
      const dAlt = flight.altitude - lastAlt
      lastAlt = flight.altitude
      const sign = dAlt > 0.05 ? 1 : dAlt < -0.05 ? -1 : 0
      if (sign !== shownAltSign) {
        shownAltSign = sign
        if (altArrow) {
          altArrow.textContent = sign > 0 ? '▲' : sign < 0 ? '▼' : '–'
          altArrow.style.color = sign > 0 ? C_GEM : sign < 0 ? C_CORAL : '#ffffff'
        }
      }

      // ---- boost: read authoritative on/off, model the meter level read-only ----
      const anyCtx = ctx as any
      const boostOn: boolean =
        typeof anyCtx.boostActive === 'boolean'
          ? anyCtx.boostActive
          : typeof anyCtx.boost === 'boolean'
            ? anyCtx.boost
            : flight.boosting
      // capacity multiplier (slows drain / speeds regen) — same source Boost.ts uses
      const up = anyCtx.upgrades
      const cap = up && typeof up.boostCap === 'number' ? THREE.MathUtils.clamp(up.boostCap, 0.5, 4) : 1
      if (boostOn) {
        boostMeter = Math.max(0, boostMeter - (BOOST_DRAIN / cap) * dt)
        sinceBoost = 0
      } else {
        sinceBoost += dt
        if (sinceBoost >= BOOST_REGEN_DELAY) {
          const fast = sinceBoost > BOOST_REGEN_DELAY + 0.8 ? BOOST_REGEN_FAST : 1
          boostMeter = Math.min(1, boostMeter + (BOOST_REGEN / cap) * dt * fast)
        }
      }
      if (boostOn !== shownBoost) {
        shownBoost = boostOn
        if (boostPill) {
          boostPill.style.boxShadow = boostOn
            ? `inset 0 0 0 1px rgba(255,255,255,.14), 0 0 12px ${C_WING}`
            : 'inset 0 0 0 1px rgba(255,255,255,.14)'
        }
      }
      const bFrac = Math.round(boostMeter * 100) / 100
      if (bFrac !== shownBoostFrac) {
        shownBoostFrac = bFrac
        if (boostFill) {
          boostFill.style.transform = `scaleX(${bFrac.toFixed(2)})`
          // tint toward sun when low so the player feels the drain
          boostFill.style.opacity = bFrac < 0.18 ? '0.55' : '1'
        }
      }

      // ---- collectible counts (write changed chips, fire a pop) ----
      for (let i = 0; i < COUNT_TYPES.length; i++) {
        const t = COUNT_TYPES[i]
        if (counts[t] !== shownCounts[t]) {
          shownCounts[t] = counts[t]
          const elc = countEls[t]
          if (elc) elc.textContent = String(counts[t])
        }
        // run the pop animation. A fresh collect "arms" the chip: we clear the
        // animation for one frame then set it, which restarts the CSS keyframe
        // cleanly even on rapid repeated pickups. Only touches the DOM on edges.
        if (popArmed[t]) {
          popArmed[t] = false
          const chip = countChips[t]
          if (chip) {
            chip.style.animation = 'none'
            // read offsetWidth to flush the 'none' before re-applying (restart)
            void chip.offsetWidth
            chip.style.animation = 'hud-pop .32s cubic-bezier(.2,1.4,.5,1)'
          }
        }
        if (popTimer[t] > 0) {
          popTimer[t] -= dt
          if (popTimer[t] <= 0) {
            const chip = countChips[t]
            if (chip) chip.style.animation = ''
          }
        }
      }

      // ---- quest tracker: flush text on change, manage visibility ----
      if (questHideTimer > 0) {
        questHideTimer -= dt
        if (questHideTimer <= 0) {
          questVisible = false
          questDirty = true
        }
      }
      if (questDirty) {
        questDirty = false
        if (questTitle && questLabel !== shownQuestLabel) {
          shownQuestLabel = questLabel
          questTitle.textContent = questLabel
        }
        if (questStep && questStepText !== shownQuestStep) {
          shownQuestStep = questStepText
          questStep.textContent = questStepText
        }
        if (questWrap && questVisible !== shownQuestVisible) {
          shownQuestVisible = questVisible
          questWrap.style.opacity = questVisible ? '1' : '0'
          if (questVisible) {
            questWrap.style.animation = 'hud-quest-in .4s ease'
          }
        }
      }

      // ---- control hints: fade out after a grace period ----
      if (!hintsFaded && hints) {
        hintsTimer += dt
        if (hintsTimer > 6) {
          hintsFaded = true
          hints.style.opacity = '0'
        }
      }

      // ---- minimap on a throttle (skip most frames) ----
      mapAccum += dt
      if (mapAccum >= MAP_THROTTLE) {
        mapAccum = 0
        drawMap(ctx)
      }
    },

    dispose() {
      if (offCollect) offCollect()
      if (offLevel) offLevel()
      if (offQStart) offQStart()
      if (offQProg) offQProg()
      if (offQDone) offQDone()
      offCollect = offLevel = offQStart = offQProg = offQDone = null
      if (layer && layer.parentElement) layer.parentElement.removeChild(layer)
      layer = null
      ringFg = null
      ringWrap = null
      lvlText = null
      speedText = null
      speedFill = null
      altText = null
      altArrow = null
      boostFill = null
      boostPill = null
      hints = null
      questWrap = null
      questTitle = null
      questStep = null
      mapCanvas = null
      mapCtx = null
      countChips.box = countChips.diamond = countChips.lantern = countChips.ring = undefined
      countEls.box = countEls.diamond = countEls.lantern = countEls.ring = undefined
    },
  }
}

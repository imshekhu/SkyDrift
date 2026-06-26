import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'
import { damp } from '../plane/flight'

/**
 * QuestRace — a ring-gate time trial woven onto the planet.
 *
 * A friendly green "Start" pylon floats in the air; flying through (or near) it
 * begins a 3-2-1-GO countdown and starts the clock. Eight glowing RING gates
 * then trace a flowing great-circle-ish path around the globe. You pass through
 * them IN ORDER:
 *   - the NEXT ring is highlighted (warm coral-gold glow, breathing scale pulse,
 *     additive halo, a spinning chevron triad in the aperture, and a soft beam
 *     toward the ring after it);
 *   - upcoming rings read as calm sky-blue, cleared rings settle to mint;
 *   - a HUD chevron at screen-bottom always points toward the next ring, fading
 *     out and growing a "behind you" hint when the gate is off-screen;
 *   - a clean tabular timer ticks at top-center with the BEST time beside it,
 *     and a checkpoint-split chip flashes the delta vs. your best pace at every
 *     ring you clear (green if ahead, coral if behind).
 *
 * Passing the final ring finishes the run: the timer stops, a finish banner
 * shows your time vs. the best (persisted to localStorage "skydrift_best"),
 * NEW BEST gets extra celebration (golden banner + confetti-less sparkle pulse),
 * and the course auto-resets so it's immediately replayable. The course is also
 * restartable on demand via (ctx as any).race.start()/reset().
 *
 * Ring pass detection is a cheap, allocation-free swept test: we intersect the
 * plane's displacement segment since last frame with the ring plane and check
 * the in-plane radius. This is robust at boost speed (no tunnelling through a
 * thin trigger).
 *
 * Perf: all rings share ONE TorusGeometry + ONE halo RingGeometry + ONE chevron
 * geometry; materials are cloned per-ring only so the active ring can glow
 * independently. update() does ZERO per-frame allocation (module-scoped
 * temporaries only). No lights are added (Lighting owns the rig). Cozy pastel
 * palette throughout; rings never compete with the coral plane.
 */

// ---- module-scoped temporaries: ZERO per-frame allocation in update() ----
const _planePos = new THREE.Vector3()
const _prevPos = new THREE.Vector3()
const _toRing = new THREE.Vector3()
const _ringNormal = new THREE.Vector3()
const _radial = new THREE.Vector3()
const _delta = new THREE.Vector3()
const _hit = new THREE.Vector3()
const _ndc = new THREE.Vector3()
const _up = new THREE.Vector3()
const _tangent = new THREE.Vector3()
const _bitangent = new THREE.Vector3()
const _basis = new THREE.Matrix4()
const _refA = new THREE.Vector3(0, 1, 0)
const _refB = new THREE.Vector3(1, 0, 0)
const _dirA = new THREE.Vector3()
const _dirB = new THREE.Vector3()
const _beamMid = new THREE.Vector3()

// cozy supporting palette (sRGB), authored to sit beside PAL
const c = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)
const COL = {
  ringIdle: c(0x9fd6ff), // soft sky-blue for not-yet gates
  ringNext: c(0xffd27a), // warm yellow-gold for the active gate (kin to plane wing, not coral)
  ringDone: c(0x7fcf9a), // gentle mint once cleared
  halo: c(0xffe9b0), // warm halo glow behind the active ring
  beam: c(0xffe9b0), // soft guide beam to the ring after next
  startGate: c(0xc6f0c0), // friendly green start pylon
  chevron: c(0xfff3cf), // pale gold chevrons inside the active ring
}

const RING_COUNT = 8
const RING_RADIUS = 7.5 // torus aperture radius (world units) — generous to fly through
const RING_TUBE = 0.7
const RING_ALT = 34 // base altitude of the ring path above the surface
const START_ALT = 26
const START_TRIGGER = 14 // proximity (world units) to arm the start
const PASS_PAD = 1.5 // forgiveness added to aperture for a valid pass

type Phase = 'idle' | 'countdown' | 'running' | 'finished'

interface Gate {
  group: THREE.Group
  torus: THREE.Mesh
  halo: THREE.Mesh
  chevrons: THREE.Mesh // spinning triad of arrows in the active gate's aperture
  beam: THREE.Mesh // soft guide quad pointing to the next gate
  mat: THREE.MeshBasicMaterial
  haloMat: THREE.MeshBasicMaterial
  chevMat: THREE.MeshBasicMaterial
  beamMat: THREE.MeshBasicMaterial
  center: THREE.Vector3
  normal: THREE.Vector3 // unit normal of the ring plane (the "forward" you fly through)
  beamLen: number // distance to the next gate (for the guide beam)
  pulse: number // eased highlight 0..1 for the active gate
  flash: number // 0..1 decaying pop when this gate is cleared
}

export function createRaceSystem(): GameSystem {
  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []
  let root: THREE.Group | null = null
  let startGate: THREE.Group | null = null
  let startMat: THREE.MeshBasicMaterial | null = null
  const gates: Gate[] = []

  let ctxRef: GameContext | null = null
  let phase: Phase = 'idle'
  let nextIndex = 0
  let raceTime = 0
  let countdown = 0 // counts DOWN from ~3.6 (incl. GO beat) during the countdown phase
  let lastCountLabel = -99
  let bestTime = Infinity
  let bestSplits: number[] = [] // per-checkpoint cumulative times of the best run
  let runSplits: number[] = [] // this run's cumulative times, captured at each gate
  let finishSparkle = 0 // celebration pulse 0..1 on a new best

  // HUD widgets
  let hudTimer: HTMLDivElement | null = null
  let hudBest: HTMLDivElement | null = null
  let hudArrow: HTMLDivElement | null = null
  let hudBanner: HTMLDivElement | null = null
  let hudSplit: HTMLDivElement | null = null
  let hudPips: HTMLDivElement | null = null
  const pipEls: HTMLSpanElement[] = []
  let splitHideAt = 0 // ctx.elapsed() time to fade the split chip

  // ---- orientation: align local +Y of an object to a world direction ----
  const orientTo = (o: THREE.Object3D, dir: THREE.Vector3) => {
    _up.copy(dir).normalize()
    const ref = Math.abs(_up.dot(_refA)) > 0.95 ? _refB : _refA
    _tangent.copy(ref)
    _tangent.addScaledVector(_up, -_tangent.dot(_up)).normalize()
    _bitangent.crossVectors(_up, _tangent).normalize()
    _basis.makeBasis(_tangent, _up, _bitangent)
    o.quaternion.setFromRotationMatrix(_basis)
  }

  // ---- a flat triple-chevron geometry pointing along +Z (in the XY plane) ----
  const buildChevrons = (): THREE.BufferGeometry => {
    // three nested ">" chevrons; drawn as thin filled arrowheads
    const verts: number[] = []
    const w = 1.7 // half-width of a chevron
    const th = 0.55 // thickness
    const tip = 1.0 // how far the point leads the wings
    for (let k = 0; k < 3; k++) {
      const z = k * 1.5 - 1.5 // stack them along the fly-through axis
      // each chevron = two slim quads forming a "v" rotated to point +Z(screen via group)
      // we lay them in local XY; the group orients XY into the ring plane.
      // upper arm
      const ax = -w, ay = w
      const bx = 0, by = 0
      // build as triangles with thickness along the arm normal
      const arm = (x0: number, y0: number, x1: number, y1: number) => {
        const dx = x1 - x0, dy = y1 - y0
        const len = Math.hypot(dx, dy) || 1
        const nx = (-dy / len) * th
        const ny = (dx / len) * th
        verts.push(
          x0 - nx, y0 - ny, z, x1 - nx, y1 - ny, z, x1 + nx, y1 + ny, z,
          x0 - nx, y0 - ny, z, x1 + nx, y1 + ny, z, x0 + nx, y0 + ny, z
        )
      }
      arm(ax, ay, bx + tip, by) // upper arm to the tip
      arm(-w, -w, bx + tip, by) // lower arm to the tip
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    geo.computeVertexNormals()
    return geo
  }

  // ---- build a single gate from shared geometry ----
  const buildGate = (idleColor: THREE.Color): Gate => {
    const group = new THREE.Group()

    const torusGeo = geometries[0] as THREE.TorusGeometry
    const haloGeo = geometries[1] as THREE.RingGeometry
    const chevGeo = geometries[3] as THREE.BufferGeometry
    const beamGeo = geometries[4] as THREE.PlaneGeometry

    const mat = new THREE.MeshBasicMaterial({
      color: idleColor,
      toneMapped: false, // gates should read as gentle emissive glows
      transparent: true,
      opacity: 0.95,
    })
    materials.push(mat)
    const torus = new THREE.Mesh(torusGeo, mat)
    // TorusGeometry lies in its local XY plane with the hole along local +Z —
    // exactly the axis we fly through, so the group's local +Z is the gate normal.
    group.add(torus)

    const haloMat = new THREE.MeshBasicMaterial({
      color: COL.halo,
      toneMapped: false,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    materials.push(haloMat)
    const halo = new THREE.Mesh(haloGeo, haloMat)
    halo.position.z = -0.05
    group.add(halo)

    // spinning chevron triad pointing through the gate (visible only when active)
    const chevMat = new THREE.MeshBasicMaterial({
      color: COL.chevron,
      toneMapped: false,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    materials.push(chevMat)
    const chevrons = new THREE.Mesh(chevGeo, chevMat)
    group.add(chevrons)

    // soft guide beam toward the next gate (only the active gate shows it)
    const beamMat = new THREE.MeshBasicMaterial({
      color: COL.beam,
      toneMapped: false,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    materials.push(beamMat)
    const beam = new THREE.Mesh(beamGeo, beamMat)
    // the unit plane spans local X in [-0.5,0.5]; we'll stretch & place per-frame
    group.add(beam)

    return {
      group,
      torus,
      halo,
      chevrons,
      beam,
      mat,
      haloMat,
      chevMat,
      beamMat,
      center: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      beamLen: 0,
      pulse: 0,
      flash: 0,
    }
  }

  // ---- lay the gates along a smooth, slightly wandering ring path ----
  const layoutCourse = (ctx: GameContext) => {
    // Build a great-circle-ish loop: pick a primary axis, walk around it, and
    // nudge the path with a seeded wobble so it isn't a flat circle. Two
    // orthogonal basis vectors (u,v) span the loop plane; w tilts it gently.
    const axis = _dirA.set(0, 1, 0)
    // a stable seeded tilt of the loop plane
    _dirB.set(ctx.rand() * 2 - 1, ctx.rand() * 0.4 + 0.3, ctx.rand() * 2 - 1).normalize()
    // u perpendicular to axis, v completes the frame
    _tangent.copy(_dirB).addScaledVector(axis, -_dirB.dot(axis)).normalize() // u
    _bitangent.crossVectors(axis, _tangent).normalize() // v

    for (let i = 0; i < gates.length; i++) {
      const t = i / gates.length
      const ang = t * Math.PI * 2
      // base loop direction in the (u,v) plane
      _ringNormal // reuse as scratch for the surface direction
        .copy(_tangent)
        .multiplyScalar(Math.cos(ang))
        .addScaledVector(_bitangent, Math.sin(ang))
      // gentle vertical wander so the course swoops up and down a little
      const wobble = Math.sin(ang * 2 + t * 3.1) * 0.18
      _ringNormal.addScaledVector(axis, wobble).normalize()

      const g = gates[i]
      const alt = RING_ALT + Math.sin(ang * 3) * 6
      g.center.copy(ctx.planet.surfacePoint(_ringNormal, alt))
    }

    // orient each gate so you fly through it heading toward the NEXT gate
    for (let i = 0; i < gates.length; i++) {
      const g = gates[i]
      const nxt = gates[(i + 1) % gates.length]
      g.normal.copy(nxt.center).sub(g.center).normalize()
      g.beamLen = g.center.distanceTo(nxt.center)
      g.group.position.copy(g.center)
      orientTo(g.group, g.normal) // local +Y -> path direction...
      // ...but the torus hole is along local +Z, so rotate the group so +Z = normal
      g.group.rotateX(-Math.PI / 2)

      // size & place the guide beam: a thin quad lying in the ring's plane,
      // stretched from the gate toward the next gate (capped so it never
      // overshoots into the next ring). It lives in local space, where +Z is
      // the fly-through direction; we orient/scale the beam mesh locally.
      const span = Math.min(g.beamLen * 0.7, RING_RADIUS * 2.4)
      g.beam.scale.set(1.4, span, 1)
      g.beam.position.set(0, 0, span * 0.5 + RING_RADIUS * 0.2)
      g.beam.rotation.set(-Math.PI / 2, 0, 0) // PlaneGeometry(1,1) in XY -> lay along local Z
    }

    // place the start gate just before ring 0, on the surface direction under
    // ring 0, and orient it so you fly THROUGH it heading toward ring 0.
    if (startGate) {
      _radial.copy(gates[0].center).normalize()
      const startPos = ctx.planet.surfacePoint(_radial, START_ALT)
      startGate.position.copy(startPos)
      // local +Z must point at ring 0 → reuse orientTo (aligns +Y) then tip +Z.
      _toRing.copy(gates[0].center).sub(startPos).normalize()
      orientTo(startGate, _toRing)
      startGate.rotateX(-Math.PI / 2) // local +Y(approach) -> local +Z(hole axis)
    }
  }

  // ---- HUD formatting ----
  const fmt = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s - m * 60
    const ss = sec.toFixed(2).padStart(5, '0')
    return m > 0 ? `${m}:${ss}` : ss
  }
  const fmtSigned = (s: number) => (s >= 0 ? '+' : '-') + fmt(Math.abs(s))

  const buildHud = (ctx: GameContext) => {
    // a wrapper for timer + best so they group cleanly at top-center
    const stack = document.createElement('div')
    stack.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:max(14px,env(safe-area-inset-top))',
      'transform:translateX(-50%)',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'gap:4px',
      'pointer-events:none',
      'opacity:0',
      'transition:opacity .3s',
    ].join(';')

    // top-center timer
    const timer = document.createElement('div')
    timer.style.cssText = [
      'padding:7px 18px',
      'border-radius:14px',
      'background:rgba(8,12,28,.5)',
      'color:#fff',
      'font-weight:700',
      'font-variant-numeric:tabular-nums',
      'font-size:22px',
      'letter-spacing:.5px',
      'text-shadow:0 1px 2px #000',
      'white-space:nowrap',
    ].join(';')
    timer.textContent = '0.00'
    stack.appendChild(timer)
    hudTimer = timer

    // best-time sub-label
    const best = document.createElement('div')
    best.style.cssText = [
      'font-size:12px',
      'font-weight:700',
      'font-variant-numeric:tabular-nums',
      'letter-spacing:.6px',
      'color:' + ringHex(COL.ringNext),
      'text-shadow:0 1px 2px #000',
      'opacity:.92',
      'white-space:nowrap',
    ].join(';')
    best.textContent = 'BEST --'
    stack.appendChild(best)
    hudBest = best

    // checkpoint pips row
    const pips = document.createElement('div')
    pips.style.cssText = [
      'display:flex',
      'gap:6px',
      'margin-top:2px',
    ].join(';')
    for (let i = 0; i < RING_COUNT; i++) {
      const pip = document.createElement('span')
      pip.style.cssText = [
        'width:9px',
        'height:9px',
        'border-radius:50%',
        'background:rgba(255,255,255,.22)',
        'box-shadow:0 1px 2px rgba(0,0,0,.5)',
        'transition:background .2s,transform .2s',
      ].join(';')
      pips.appendChild(pip)
      pipEls.push(pip)
    }
    stack.appendChild(pips)
    hudPips = pips

    ctx.hud.root.appendChild(stack)

    // checkpoint split chip (flashes the delta vs best pace) — just below stack
    const split = document.createElement('div')
    split.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:max(96px,calc(env(safe-area-inset-top) + 82px))',
      'transform:translate(-50%,-6px)',
      'padding:4px 12px',
      'border-radius:11px',
      'background:rgba(8,12,28,.45)',
      'font-weight:800',
      'font-variant-numeric:tabular-nums',
      'font-size:16px',
      'letter-spacing:.4px',
      'text-shadow:0 1px 2px #000',
      'white-space:nowrap',
      'pointer-events:none',
      'opacity:0',
      'transition:opacity .25s,transform .25s',
    ].join(';')
    ctx.hud.root.appendChild(split)
    hudSplit = split

    // big center banner (countdown / GO / finish)
    const banner = document.createElement('div')
    banner.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:38%',
      'transform:translate(-50%,-50%) scale(1)',
      'color:#fff',
      'font-weight:800',
      'font-size:64px',
      'line-height:1.05',
      'text-shadow:0 2px 12px rgba(0,0,0,.6)',
      'opacity:0',
      'transition:opacity .25s,transform .25s,color .25s',
      'white-space:pre-line',
      'text-align:center',
      'pointer-events:none',
    ].join(';')
    ctx.hud.root.appendChild(banner)
    hudBanner = banner

    // direction chevron toward the next ring, anchored low-center
    const arrow = document.createElement('div')
    arrow.style.cssText = [
      'position:absolute',
      'left:50%',
      'bottom:max(22%,env(safe-area-inset-bottom))',
      'width:0',
      'height:0',
      'margin-left:-17px',
      'border-left:17px solid transparent',
      'border-right:17px solid transparent',
      'border-bottom:32px solid ' + ringHex(COL.ringNext),
      'filter:drop-shadow(0 1px 4px rgba(0,0,0,.55))',
      'transform-origin:50% 70%',
      'opacity:0',
      'transition:opacity .3s',
      'pointer-events:none',
    ].join(';')
    ctx.hud.root.appendChild(arrow)
    hudArrow = arrow
  }

  const setBanner = (text: string, show: boolean, pop = false, color = '#ffffff') => {
    if (!hudBanner) return
    hudBanner.textContent = text
    hudBanner.style.color = color
    hudBanner.style.opacity = show ? '1' : '0'
    hudBanner.style.transform = `translate(-50%,-50%) scale(${show && pop ? 1.18 : 1})`
  }

  const setBest = () => {
    if (hudBest) hudBest.textContent = 'BEST ' + (isFinite(bestTime) ? fmt(bestTime) : '--')
  }

  const flashSplit = (deltaText: string, ahead: boolean | null, elapsed: number) => {
    if (!hudSplit) return
    hudSplit.textContent = deltaText
    hudSplit.style.color =
      ahead == null ? '#ffffff' : ahead ? ringHex(COL.ringDone) : ringHex(COL.ringNext)
    hudSplit.style.opacity = '1'
    hudSplit.style.transform = 'translate(-50%,0) scale(1.06)'
    splitHideAt = elapsed + 1.6
  }

  const updatePips = () => {
    for (let i = 0; i < pipEls.length; i++) {
      const el = pipEls[i]
      if (phase === 'running' && i < nextIndex) {
        el.style.background = ringHex(COL.ringDone)
        el.style.transform = 'scale(1)'
      } else if (phase === 'running' && i === nextIndex) {
        el.style.background = ringHex(COL.ringNext)
        el.style.transform = 'scale(1.35)'
      } else if (phase === 'finished') {
        el.style.background = ringHex(COL.ringDone)
        el.style.transform = 'scale(1)'
      } else {
        el.style.background = 'rgba(255,255,255,.22)'
        el.style.transform = 'scale(1)'
      }
    }
  }

  // ---- state transitions ----
  const armStart = () => {
    if (!ctxRef || (phase !== 'idle' && phase !== 'finished')) return
    phase = 'countdown'
    countdown = 3.6 // 3..2..1 then a brief GO beat handled at <=0
    lastCountLabel = -99
    raceTime = 0
    nextIndex = 0
    finishSparkle = 0
    runSplits = []
    if (hudTimer?.parentElement) (hudTimer.parentElement as HTMLElement).style.opacity = '1'
    if (hudArrow) hudArrow.style.opacity = '0'
    if (hudSplit) hudSplit.style.opacity = '0'
    setBest()
    updatePips()
    refreshGateColors()
    ctxRef.audio.play('collect', { volume: 0.7, rate: 0.9 })
  }

  const startRun = () => {
    if (!ctxRef) return
    phase = 'running'
    raceTime = 0
    nextIndex = 0
    runSplits = []
    setBanner('GO!', true, true, ringHex(COL.ringDone))
    if (hudArrow) hudArrow.style.opacity = '1'
    updatePips()
    refreshGateColors()
    setTimeout(() => {
      if (phase === 'running') setBanner('', false)
    }, 650)
    ctxRef.events.emit('questStart', { id: 'race', label: 'Sky Circuit' })
    ctxRef.audio.play('boost', { volume: 0.6 })
  }

  const finishRun = () => {
    if (!ctxRef) return
    phase = 'finished'
    const time = raceTime
    const isBest = time < bestTime
    if (isBest) {
      bestTime = time
      bestSplits = runSplits.slice()
      finishSparkle = 1
      try {
        localStorage.setItem('skydrift_best', String(time))
        localStorage.setItem('skydrift_best_splits', JSON.stringify(bestSplits))
      } catch {
        /* storage may be unavailable (private mode); ignore */
      }
    }
    if (hudArrow) hudArrow.style.opacity = '0'
    if (hudSplit) hudSplit.style.opacity = '0'
    setBest()
    updatePips()
    const bestStr = isFinite(bestTime) ? fmt(bestTime) : '--'
    setBanner(
      (isBest ? 'NEW BEST!\n' : 'FINISH!\n') + fmt(time),
      true,
      true,
      isBest ? ringHex(COL.ringNext) : '#ffffff'
    )
    ctxRef.hud.toast(
      `${isBest ? 'New best ' : 'Finished '}${fmt(time)} (best ${bestStr})`,
      2600
    )
    ctxRef.events.emit('questComplete', { id: 'race', label: 'Sky Circuit', time, best: bestTime })
    ctxRef.audio.play('levelup', { volume: 0.9, rate: isBest ? 1.0 : 0.85 })
    refreshGateColors()
    // auto-reset to idle so the course is immediately replayable
    setTimeout(() => {
      if (phase === 'finished') resetToIdle()
    }, 3400)
  }

  const resetToIdle = () => {
    phase = 'idle'
    nextIndex = 0
    raceTime = 0
    finishSparkle = 0
    runSplits = []
    if (hudTimer) hudTimer.textContent = fmt(0)
    if (hudTimer?.parentElement) (hudTimer.parentElement as HTMLElement).style.opacity = '0'
    if (hudArrow) hudArrow.style.opacity = '0'
    if (hudSplit) hudSplit.style.opacity = '0'
    setBanner('', false)
    updatePips()
    refreshGateColors()
  }

  const advanceGate = () => {
    if (!ctxRef) return
    const cleared = nextIndex
    runSplits[cleared] = raceTime
    nextIndex++
    gates[cleared].flash = 1

    // checkpoint split vs best pace
    if (bestSplits.length > cleared && isFinite(bestSplits[cleared])) {
      const delta = raceTime - bestSplits[cleared]
      flashSplit(fmtSigned(delta), delta <= 0, ctxRef.elapsed())
    } else {
      flashSplit('CP ' + (cleared + 1), null, ctxRef.elapsed())
    }

    ctxRef.audio.play('collect', { volume: 0.85, rate: 1.15 + cleared * 0.05 })
    ctxRef.events.emit('questProgress', {
      id: 'race',
      label: 'Sky Circuit',
      current: nextIndex,
      total: gates.length,
    })
    updatePips()
    if (nextIndex >= gates.length) {
      finishRun()
    } else {
      refreshGateColors()
    }
  }

  // recolor gates to reflect: done / next / upcoming
  const refreshGateColors = () => {
    for (let i = 0; i < gates.length; i++) {
      const g = gates[i]
      if (phase === 'running' && i === nextIndex) {
        g.mat.color.copy(COL.ringNext)
      } else if (phase === 'running' && i < nextIndex) {
        g.mat.color.copy(COL.ringDone)
      } else if (phase === 'finished') {
        g.mat.color.copy(COL.ringDone)
      } else {
        g.mat.color.copy(COL.ringIdle)
      }
    }
  }

  // ---- ring pass test (allocation-free) ----
  // Returns true if the segment prev->cur crossed gate g's plane this frame
  // within the aperture.
  const crossedGate = (g: Gate, prev: THREE.Vector3, cur: THREE.Vector3): boolean => {
    _ringNormal.copy(g.normal)
    // signed distances to the ring plane for both endpoints
    _toRing.copy(prev).sub(g.center)
    const dPrev = _toRing.dot(_ringNormal)
    _toRing.copy(cur).sub(g.center)
    const dCur = _toRing.dot(_ringNormal)
    // must cross from the front (approaching) side to the back side
    if (dPrev > 0 || dCur <= 0) return false
    const denom = dCur - dPrev
    if (Math.abs(denom) < 1e-5) return false
    const t = -dPrev / denom // param along the segment where it hits the plane
    if (t < 0 || t > 1) return false
    // intersection point, then distance from ring center within the plane
    _hit.copy(prev).addScaledVector(_delta.copy(cur).sub(prev), t)
    _hit.sub(g.center)
    // radial distance in-plane (subtract the normal component)
    const along = _hit.dot(_ringNormal)
    _hit.addScaledVector(_ringNormal, -along)
    return _hit.length() <= RING_RADIUS + PASS_PAD
  }

  return {
    name: 'race',

    init(ctx: GameContext) {
      ctxRef = ctx

      // shared geometries (0 = torus, 1 = halo ring, 2 = start torus, 3 = chevrons, 4 = beam)
      geometries.push(new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 8, 24)) // 0
      geometries.push(new THREE.RingGeometry(RING_RADIUS - 0.4, RING_RADIUS + 1.8, 28)) // 1
      geometries.push(new THREE.TorusGeometry(RING_RADIUS + 1, RING_TUBE * 1.4, 8, 24)) // 2
      geometries.push(buildChevrons()) // 3
      geometries.push(new THREE.PlaneGeometry(1, 1)) // 4 (unit, scaled per gate)

      root = new THREE.Group()
      root.name = 'race-course'

      // start pylon: a thicker green ring that reads as a gateway
      startGate = new THREE.Group()
      startMat = new THREE.MeshBasicMaterial({
        color: COL.startGate,
        toneMapped: false,
        transparent: true,
        opacity: 0.95,
      })
      materials.push(startMat)
      const startRing = new THREE.Mesh(geometries[2], startMat)
      // TorusGeometry hole is along local +Z, which is exactly the fly-through
      // axis we want, so no extra mesh rotation is needed here.
      startGate.add(startRing)
      root.add(startGate)

      // build the 8 gates from shared geometry
      for (let i = 0; i < RING_COUNT; i++) {
        const g = buildGate(COL.ringIdle)
        gates.push(g)
        root.add(g.group)
      }

      ctx.scene.add(root)
      layoutCourse(ctx)
      refreshGateColors()

      // load best time + splits
      try {
        const raw = localStorage.getItem('skydrift_best')
        if (raw != null) {
          const v = parseFloat(raw)
          if (isFinite(v) && v > 0) bestTime = v
        }
        const rawS = localStorage.getItem('skydrift_best_splits')
        if (rawS != null) {
          const arr = JSON.parse(rawS)
          if (Array.isArray(arr)) {
            bestSplits = arr.filter((n) => typeof n === 'number' && isFinite(n))
          }
        }
      } catch {
        /* ignore */
      }

      buildHud(ctx)
      setBest()
      updatePips()

      // seed prevPos so the first frame's segment is degenerate (no false pass)
      ctx.player.obj.getWorldPosition(_prevPos)

      // publish a tiny registry so other systems / a quest log can reflect state
      ;(ctx as any).race = {
        get phase() {
          return phase
        },
        get best() {
          return bestTime
        },
        get next() {
          return nextIndex
        },
        get total() {
          return gates.length
        },
        get time() {
          return raceTime
        },
        start: armStart,
        reset: resetToIdle,
      }
    },

    update(dt: number, ctx: GameContext) {
      ctx.player.obj.getWorldPosition(_planePos)
      const now = ctx.elapsed()

      // --- arm the start when the plane is near the start gate (idle only) ---
      if (phase === 'idle' && startGate) {
        _toRing.copy(_planePos).sub(startGate.position)
        if (_toRing.lengthSq() < START_TRIGGER * START_TRIGGER) {
          armStart()
        }
      }

      // --- countdown: 3..2..1 then GO ---
      if (phase === 'countdown') {
        countdown -= dt
        const label = Math.ceil(countdown)
        if (label !== lastCountLabel && label >= 1 && label <= 3 && countdown > 0.6) {
          lastCountLabel = label
          setBanner(String(label), true, true, '#ffffff')
          ctx.audio.play('collect', { volume: 0.6, rate: 0.78 + (3 - label) * 0.13 })
        }
        if (countdown <= 0) startRun()
      }

      // --- running: accumulate time, swept-test the next gate, drive the arrow ---
      if (phase === 'running') {
        raceTime += dt
        if (hudTimer) hudTimer.textContent = fmt(raceTime)

        const g = gates[nextIndex]
        if (g && crossedGate(g, _prevPos, _planePos)) {
          advanceGate()
        }

        // arrow: point from screen-center toward the next ring's projected pos
        updateArrow(ctx)
      }

      // fade the split chip when its time is up
      if (hudSplit && hudSplit.style.opacity === '1' && now >= splitHideAt) {
        hudSplit.style.opacity = '0'
        hudSplit.style.transform = 'translate(-50%,-6px) scale(1)'
      }

      // celebration sparkle decays after a new best
      if (finishSparkle > 0) finishSparkle = Math.max(0, finishSparkle - dt * 0.6)

      // --- per-gate visuals: pulse, spin, chevrons, beam, clear-flash ---
      const beat = 0.5 + 0.5 * Math.sin(now * 4)
      for (let i = 0; i < gates.length; i++) {
        const g = gates[i]
        const wantActive = phase === 'running' && i === nextIndex
        g.pulse += ((wantActive ? 1 : 0) - g.pulse) * damp(7, dt)
        // decaying pop when a gate is cleared
        g.flash = Math.max(0, g.flash - dt * 2.2)

        // scale breathe on the active gate + a snappy pop on clear
        const s = 1 + g.pulse * 0.06 * beat + g.flash * 0.18
        g.group.scale.setScalar(s)

        // halo: steady glow on the active gate, bright burst on clear
        g.haloMat.opacity = g.pulse * (0.32 + 0.2 * beat) + g.flash * 0.6

        // slow idle spin so gates feel alive (about their own normal = local +Z)
        g.torus.rotation.z += dt * (0.2 + g.pulse * 0.6)

        // ring opacity: a hair brighter when active, plus finish sparkle on all
        const sparkle = phase === 'finished' ? finishSparkle * 0.25 * beat : 0
        g.mat.opacity = 0.8 + g.pulse * 0.2 + sparkle

        // chevrons: only the active gate shows them; they spin & breathe forward
        const chevOn = g.pulse > 0.02
        if (chevOn) {
          g.chevrons.visible = true
          g.chevMat.opacity = g.pulse * (0.45 + 0.35 * beat)
          g.chevrons.rotation.z += dt * 0.9
          // gentle forward "draw" toward the player to read as "go this way"
          g.chevrons.position.z = -1.2 + 0.8 * (0.5 + 0.5 * Math.sin(now * 3))
        } else if (g.chevrons.visible) {
          g.chevrons.visible = false
        }

        // guide beam to the next ring: fade in on the active gate only
        const beamOn = g.pulse > 0.02
        if (beamOn) {
          g.beam.visible = true
          g.beamMat.opacity = g.pulse * (0.16 + 0.08 * beat)
        } else if (g.beam.visible) {
          g.beam.visible = false
        }
      }

      // gentle pulse on the start gate while idle to invite the player
      if (startMat) {
        const inviting = phase === 'idle'
        const target = inviting ? 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(now * 2.4)) : 0.18
        startMat.opacity += (target - startMat.opacity) * damp(6, dt)
      }

      // remember position for next frame's segment test
      _prevPos.copy(_planePos)
    },

    dispose() {
      if (root) {
        root.parent?.remove(root)
        root = null
      }
      for (const g of geometries) g.dispose()
      for (const m of materials) m.dispose()
      geometries.length = 0
      materials.length = 0
      gates.length = 0
      startGate = null
      startMat = null
      // the timer/best/pips share one wrapper element; remove it once
      hudTimer?.parentElement?.remove()
      hudArrow?.remove()
      hudBanner?.remove()
      hudSplit?.remove()
      hudTimer = hudBest = hudArrow = hudBanner = hudSplit = hudPips = null
      pipEls.length = 0
      if (ctxRef) delete (ctxRef as any).race
      ctxRef = null
    },
  }

  // ---- arrow projection (kept as a closure so it can see hudArrow) ----
  function updateArrow(ctx: GameContext) {
    if (!hudArrow) return
    const g = gates[nextIndex]
    if (!g) {
      hudArrow.style.opacity = '0'
      return
    }
    // project ring center to NDC, derive a screen angle from center
    _ndc.copy(g.center).project(ctx.camera)
    const behind = _ndc.z > 1 // beyond far / behind camera after projection
    // direction in screen space (y up in NDC, flip for CSS)
    let x = _ndc.x
    let y = _ndc.y
    if (behind) {
      // when behind, point opposite so the arrow guides you to turn around
      x = -x
      y = -y
    }
    // is the target comfortably on-screen and ahead? dim the arrow then.
    const onScreen = !behind && Math.abs(_ndc.x) < 0.55 && Math.abs(_ndc.y) < 0.55
    // angle of the arrow: 0 = pointing up; rotate toward the target direction
    const ang = Math.atan2(x, y) // screen-space heading toward target
    hudArrow.style.opacity = onScreen ? '0.35' : '1'
    hudArrow.style.transform = `rotate(${ang}rad)`
  }
}

// helper: THREE.Color -> css rgb() (sRGB) for DOM borders/text
function ringHex(col: THREE.Color): string {
  const r = Math.round(col.r * 255)
  const g = Math.round(col.g * 255)
  const b = Math.round(col.b * 255)
  return `rgb(${r},${g},${b})`
}

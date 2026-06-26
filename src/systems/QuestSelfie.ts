import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'
import { damp } from '../plane/flight'

/**
 * QuestSelfie — the LANDMARK SELFIE quest.
 *
 * Reads the landmark registry the Landmarks system publishes on the shared
 * context: `(ctx as any).landmarks`. We poll for it in update() until it shows
 * up (init order between sibling systems is not guaranteed), then pick one
 * target landmark and guide the player to it.
 *
 * The juice, in order of how the player meets it:
 *   - a HUD prompt at the bottom ("Fly to the {label} …"),
 *   - a screen-edge CHEVRON that points at the off-screen landmark, with a live
 *     distance readout, so you always know where to fly,
 *   - a cozy proximity RING that breathes and tightens as you close in,
 *   - a viewfinder FRAMING vignette (soft letterbox + corner brackets + a
 *     reticle) that fades up when you're in range — the world reads as a shot,
 *   - on C: a real camera SHUTTER (two-stage black blink + white flash), a tiny
 *     hold, and a POLAROID that slides up from the corner and "develops" from a
 *     blank chemical wash into the captured freeze-frame, with a sparkle burst
 *     and a hand-written caption + a little FRAMING score (★),
 *   - an XP reward (emitted as a `collect` event so Progression banks it),
 *   - a `questComplete` event, then we advance to the next landmark.
 *
 * Registry shape tolerance: the Landmarks system publishes rich objects
 * ({ id,name,label,position,dir,selfieRadius }), but the contract loosely
 * describes "an array of Vector3". We accept BOTH — a plain Vector3 is wrapped
 * with sensible defaults — so this compiles and runs against either producer.
 *
 * Perf: update() does only cheap scalar math + a couple of distance checks and
 * one project()-to-screen on the steady path, with ZERO per-frame allocation
 * (all vectors are module-scoped temporaries). All DOM is built once and
 * reused; we only touch styles that actually changed. The thumbnail canvas is a
 * single small 2D canvas we draw into on demand. No Three.js objects are added
 * to the scene, so the lights / draw-call budget is untouched.
 */

// ---- a loose view over whatever the Landmarks system publishes ----
interface SelfieTarget {
  id: string
  label: string
  /** world-space framing anchor (where we aim the prompt distance from) */
  position: THREE.Vector3
  /** how close (world units) the plane must be for a valid selfie */
  selfieRadius: number
}

// ----- module-scoped temporaries: zero per-frame allocation -----
const _toTarget = new THREE.Vector3()
const _tmp = new THREE.Vector3()
const _proj = new THREE.Vector3()

// reward + tuning constants
const SELFIE_XP = 14 // banked via a `collect` event (Progression reads .xp)
const REGISTRY_POLL = 0.25 // seconds between registry polls while we wait
const FLASH_FADE = 7 // damp() rate for the white flash fade-out
const SHUTTER_FADE = 16 // damp() rate for the (faster) black shutter blink
const FRAME_RATE = 5 // damp() rate for the viewfinder framing fade
const RING_RATE = 8 // damp() rate for the proximity-ring radius follow
const CHEVRON_RATE = 12 // damp() rate for edge-chevron position follow
const THUMB_W = 154 // freeze-frame thumbnail width (px, CSS + capture)
const THUMB_H = 104
const DEFAULT_RADIUS = 24 // fallback selfie radius if registry omits one
const NEAR_HYSTERESIS = 1.15 // leave-radius is a touch larger than enter (no flicker)
const RING_LEAD = 2.4 // proximity ring becomes visible within radius*lead
const FRAME_MARGIN = 16 // px the edge-chevron keeps from the viewport edge

const css = (col: { r: number; g: number; b: number }): string =>
  `rgb(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)})`
const withAlpha = (col: { r: number; g: number; b: number }, a: number): string =>
  `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${a})`

export function createSelfieQuestSystem(): GameSystem {
  let ctxRef: GameContext | null = null

  // honor the OS "reduce motion" hint — keep the juice, drop the big transforms
  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // resolved target list (normalized from the registry) + current index
  const targets: SelfieTarget[] = []
  let haveRegistry = false
  let pollAccum = 0
  let currentIndex = -1

  // proximity state (so the prompt can reflect near/far and we avoid flicker)
  let inRange = false

  // input: a single window keydown listener, gated by a flag
  let keyArmed = false // true once a target is active and we're listening
  let pressedC = false // set by listener, consumed in update()
  let onKeyDown: ((e: KeyboardEvent) => void) | null = null

  // ---- DOM (built lazily, reused) ----
  let promptEl: HTMLDivElement | null = null
  let promptLabelEl: HTMLSpanElement | null = null
  let promptHintEl: HTMLSpanElement | null = null
  let chevronEl: HTMLDivElement | null = null
  let chevronArrowEl: HTMLSpanElement | null = null
  let chevronDistEl: HTMLSpanElement | null = null
  let frameEl: HTMLDivElement | null = null // viewfinder overlay (vignette+brackets)
  let frameReticleEl: HTMLDivElement | null = null
  let ringEl: HTMLDivElement | null = null // breathing proximity ring
  let flashEl: HTMLDivElement | null = null // white flash
  let shutterEl: HTMLDivElement | null = null // black shutter blink
  let polaroidEl: HTMLDivElement | null = null
  let polaroidImgWrap: HTMLDivElement | null = null
  let polaroidCaption: HTMLDivElement | null = null
  let polaroidStarsEl: HTMLDivElement | null = null
  let developEl: HTMLDivElement | null = null // chemical wash over the photo
  let sparkleEl: HTMLDivElement | null = null

  // freeze-frame capture surface (a 2D canvas we draw the WebGL frame into)
  let thumbCanvas: HTMLCanvasElement | null = null
  let thumbCtx: CanvasRenderingContext2D | null = null
  let thumbImg: HTMLImageElement | null = null

  // animation state (driven in update, dt-invariant via damp())
  let flashAlpha = 0
  let shutterAlpha = 0
  let frameAmt = 0 // 0..1 viewfinder presence (eased toward a target)
  let frameTarget = 0
  let ringShown = false
  let ringScale = 1 // current eased ring scale (1 == at radius)
  let chevronShown = false
  let chevronX = 0 // current eased chevron screen position
  let chevronY = 0
  // a short post-snap "settle" window where we hold the framing & lock input
  let snapHoldUntil = 0
  // wall-clock breathing phase for the ring/reticle (no per-frame alloc)
  let pulseT = 0

  // polaroid pop/auto-hide + develop timers (wall-clock via elapsed())
  let polaroidHideAt = 0 // elapsed() time to hide the polaroid (0 = hidden)
  let developClearAt = 0 // elapsed() time to finish the develop animation

  const ACCENT = css(PAL.gem) // cozy cyan accent matches the gem token
  const CORAL = css(PAL.planeBody)
  const SUN = css(PAL.sun)

  // -------------------------------------------------------------------------
  // registry normalization
  // -------------------------------------------------------------------------
  function adopt(raw: any): SelfieTarget[] | null {
    if (!Array.isArray(raw) || raw.length === 0) return null
    const out: SelfieTarget[] = []
    for (let i = 0; i < raw.length; i++) {
      const e = raw[i]
      if (!e) continue
      // Case A: rich LandmarkInfo-like object with a .position Vector3.
      if (e.position && typeof e.position.x === 'number') {
        out.push({
          id: typeof e.id === 'string' ? e.id : `landmark-${i}`,
          label:
            typeof e.label === 'string'
              ? e.label
              : typeof e.name === 'string'
                ? e.name
                : `Landmark ${i + 1}`,
          position: e.position as THREE.Vector3,
          selfieRadius:
            typeof e.selfieRadius === 'number' && e.selfieRadius > 0
              ? e.selfieRadius
              : DEFAULT_RADIUS,
        })
        continue
      }
      // Case B: a bare Vector3 (matches the loose contract wording).
      if (typeof e.x === 'number' && typeof e.y === 'number' && typeof e.z === 'number') {
        out.push({
          id: `landmark-${i}`,
          label: `Landmark ${i + 1}`,
          position: e as THREE.Vector3,
          selfieRadius: DEFAULT_RADIUS,
        })
      }
    }
    return out.length ? out : null
  }

  // -------------------------------------------------------------------------
  // DOM construction (once)
  // -------------------------------------------------------------------------
  function buildDom(ctx: GameContext) {
    const root = ctx.hud.root

    // --- bottom-center prompt ---
    const p = document.createElement('div')
    p.style.cssText = [
      'position:absolute',
      'left:50%',
      'bottom:calc(env(safe-area-inset-bottom,0px) + 92px)',
      'transform:translateX(-50%) translateY(8px)',
      'display:none',
      'align-items:center',
      'gap:9px',
      'padding:9px 16px',
      'border-radius:14px',
      'background:rgba(8,12,28,.58)',
      'backdrop-filter:blur(7px)',
      '-webkit-backdrop-filter:blur(7px)',
      'box-shadow:0 6px 22px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.07)',
      `border-left:3px solid ${ACCENT}`,
      'font:600 14px/1.2 system-ui,-apple-system,sans-serif',
      'color:#fff',
      'text-shadow:0 1px 3px rgba(0,0,0,.6)',
      'white-space:nowrap',
      'opacity:0',
      'transition:opacity .35s ease,transform .35s ease',
      'pointer-events:none',
      '-webkit-user-select:none',
      'user-select:none',
      'z-index:14',
    ].join(';')

    const cam = document.createElement('span')
    cam.textContent = '📷'
    cam.style.cssText = 'font-size:18px;line-height:1'

    const text = document.createElement('span')
    const lead = document.createElement('span')
    lead.textContent = 'Fly to the '
    const lbl = document.createElement('span')
    lbl.style.cssText = `font-weight:800;color:${ACCENT}`
    const mid = document.createElement('span')
    mid.textContent = ' and '
    // The hint switches between "get closer" and "press C" based on range.
    const hint = document.createElement('span')
    hint.style.cssText = 'font-weight:800'

    text.appendChild(lead)
    text.appendChild(lbl)
    text.appendChild(mid)
    text.appendChild(hint)

    p.appendChild(cam)
    p.appendChild(text)
    root.appendChild(p)
    promptEl = p
    promptLabelEl = lbl
    promptHintEl = hint

    // --- screen-edge chevron pointing at the (off-screen) landmark ---
    const chev = document.createElement('div')
    chev.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      'display:none',
      'flex-direction:column',
      'align-items:center',
      'gap:2px',
      'transform:translate(-50%,-50%)',
      'pointer-events:none',
      'opacity:0',
      'transition:opacity .3s ease',
      'will-change:transform,opacity',
      'z-index:13',
      '-webkit-user-select:none',
      'user-select:none',
    ].join(';')
    const chevArrow = document.createElement('span')
    chevArrow.textContent = '➤'
    chevArrow.style.cssText = [
      `color:${ACCENT}`,
      'font-size:22px',
      'line-height:1',
      'filter:drop-shadow(0 2px 4px rgba(0,0,0,.55))',
      'transform-origin:center',
      'will-change:transform',
    ].join(';')
    const chevDist = document.createElement('span')
    chevDist.style.cssText = [
      'font:800 11px/1 system-ui,-apple-system,sans-serif',
      'color:#fff',
      'background:rgba(8,12,28,.6)',
      'padding:2px 6px',
      'border-radius:8px',
      'text-shadow:0 1px 2px rgba(0,0,0,.6)',
      'white-space:nowrap',
    ].join(';')
    chev.appendChild(chevArrow)
    chev.appendChild(chevDist)
    root.appendChild(chev)
    chevronEl = chev
    chevronArrowEl = chevArrow
    chevronDistEl = chevDist

    // --- viewfinder framing overlay (letterbox vignette + corner brackets) ---
    const frame = document.createElement('div')
    frame.style.cssText = [
      'position:absolute',
      'inset:0',
      'pointer-events:none',
      'opacity:0',
      'z-index:12',
      'will-change:opacity',
      // soft cinematic vignette via layered radial+linear gradients
      'background:' +
        'radial-gradient(120% 90% at 50% 50%, transparent 52%, rgba(6,10,22,.32) 100%),' +
        'linear-gradient(to bottom, rgba(6,10,22,.34), transparent 14%, transparent 86%, rgba(6,10,22,.34))',
    ].join(';')

    // four corner brackets (drawn with borders on small absolutely-placed divs)
    const bk = 34 // bracket arm length
    const inset = '6.5%'
    const corners: Array<[string, string, string]> = [
      // [pos, borderTop+Left, label]
      [`top:${inset};left:${inset}`, 'border-top:2px solid;border-left:2px solid', 'tl'],
      [`top:${inset};right:${inset}`, 'border-top:2px solid;border-right:2px solid', 'tr'],
      [`bottom:${inset};left:${inset}`, 'border-bottom:2px solid;border-left:2px solid', 'bl'],
      [`bottom:${inset};right:${inset}`, 'border-bottom:2px solid;border-right:2px solid', 'br'],
    ]
    for (let i = 0; i < corners.length; i++) {
      const [pos, borders] = corners[i]
      const b = document.createElement('div')
      b.style.cssText = [
        'position:absolute',
        pos,
        `width:${bk}px`,
        `height:${bk}px`,
        borders,
        `border-color:${withAlpha(PAL.sun, 0.85)}`,
        'border-radius:3px',
        'box-shadow:0 0 6px rgba(0,0,0,.35)',
      ].join(';')
      frame.appendChild(b)
    }

    // center reticle (breathes in update via pulseT)
    const ret = document.createElement('div')
    ret.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:50%',
      'width:40px',
      'height:40px',
      'margin:-20px 0 0 -20px',
      'border:2px solid ' + withAlpha(PAL.gem, 0.85),
      'border-radius:50%',
      'box-shadow:0 0 10px ' + withAlpha(PAL.gem, 0.5) + ', inset 0 0 8px ' + withAlpha(PAL.gem, 0.4),
      'will-change:transform',
    ].join(';')
    // tiny crosshair tick in the reticle center
    const tick = document.createElement('div')
    tick.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:50%',
      'width:6px',
      'height:6px',
      'margin:-3px 0 0 -3px',
      'border-radius:50%',
      'background:' + withAlpha(PAL.sun, 0.9),
    ].join(';')
    ret.appendChild(tick)
    frame.appendChild(ret)
    frameReticleEl = ret

    root.appendChild(frame)
    frameEl = frame

    // --- breathing proximity ring (centered on screen; scales with distance) ---
    const ring = document.createElement('div')
    ring.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:50%',
      'width:42vmin',
      'height:42vmin',
      'max-width:520px',
      'max-height:520px',
      'margin:0',
      'border-radius:50%',
      'border:2px dashed ' + withAlpha(PAL.gem, 0.55),
      'box-shadow:0 0 18px ' + withAlpha(PAL.gem, 0.28),
      'transform:translate(-50%,-50%) scale(1.4)',
      'opacity:0',
      'pointer-events:none',
      'transition:opacity .35s ease',
      'will-change:transform,opacity',
      'z-index:11',
    ].join(';')
    root.appendChild(ring)
    ringEl = ring

    // --- full-screen black shutter blink (fast, sits under the white flash) ---
    const sh = document.createElement('div')
    sh.style.cssText = [
      'position:absolute',
      'inset:0',
      'background:#05070f',
      'opacity:0',
      'pointer-events:none',
      'z-index:29',
      'will-change:opacity',
    ].join(';')
    root.appendChild(sh)
    shutterEl = sh

    // --- full-screen white flash ---
    const fl = document.createElement('div')
    fl.style.cssText = [
      'position:absolute',
      'inset:0',
      'background:#ffffff',
      'opacity:0',
      'pointer-events:none',
      'z-index:30',
      'will-change:opacity',
    ].join(';')
    root.appendChild(fl)
    flashEl = fl

    // --- freeze-frame polaroid (top-right corner) ---
    const pol = document.createElement('div')
    // it parks just off the top-right corner and slides in on snap
    const restTransform = reduceMotion
      ? 'translate(0,0) scale(1) rotate(3deg)'
      : 'translate(36px,-26px) scale(.72) rotate(8deg)'
    pol.style.cssText = [
      'position:absolute',
      'top:calc(env(safe-area-inset-top,0px) + 14px)',
      'right:calc(env(safe-area-inset-right,0px) + 14px)',
      'display:none',
      'flex-direction:column',
      'gap:6px',
      'padding:7px 7px 9px',
      'background:linear-gradient(180deg,#fffdf8,#f4ecdc)',
      'border-radius:8px',
      'box-shadow:0 14px 34px rgba(0,0,0,.42),0 0 0 1px rgba(0,0,0,.05)',
      'transform-origin:top right',
      `transform:${restTransform}`,
      'opacity:0',
      'transition:transform .42s cubic-bezier(.16,.84,.28,1.2),opacity .3s ease',
      'pointer-events:none',
      'z-index:26',
    ].join(';')

    const imgWrap = document.createElement('div')
    imgWrap.style.cssText = [
      'position:relative',
      `width:${THUMB_W}px`,
      `height:${THUMB_H}px`,
      'border-radius:4px',
      'overflow:hidden',
      'background:linear-gradient(180deg,#a9d6ef,#cfeefb)',
    ].join(';')

    const img = document.createElement('img')
    img.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover'
    img.alt = ''
    imgWrap.appendChild(img)
    thumbImg = img

    // "develop" chemical wash that fades away to reveal the photo
    const dev = document.createElement('div')
    dev.style.cssText = [
      'position:absolute',
      'inset:0',
      'pointer-events:none',
      'opacity:0',
      'background:linear-gradient(180deg,#cdbfa6,#9c8f78)',
      'transition:opacity .9s ease',
    ].join(';')
    imgWrap.appendChild(dev)
    developEl = dev

    // sparkle layer over the photo
    const spk = document.createElement('div')
    spk.style.cssText = [
      'position:absolute',
      'inset:0',
      'pointer-events:none',
      'opacity:0',
      'background:' +
        'radial-gradient(circle at 24% 30%, rgba(255,255,255,.95) 0 2px, transparent 3px),' +
        'radial-gradient(circle at 70% 22%, rgba(255,255,255,.9) 0 1.5px, transparent 3px),' +
        'radial-gradient(circle at 58% 64%, rgba(255,255,255,.95) 0 2px, transparent 3px),' +
        'radial-gradient(circle at 36% 78%, rgba(255,255,255,.85) 0 1.5px, transparent 3px),' +
        `radial-gradient(circle at 82% 70%, ${withAlpha(PAL.gem, 0.95)} 0 2px, transparent 3px)`,
      'transition:opacity .5s ease',
    ].join(';')
    imgWrap.appendChild(spk)
    sparkleEl = spk

    const cap = document.createElement('div')
    cap.style.cssText = [
      'font:700 11px/1.25 "Bradley Hand","Segoe Print",system-ui,sans-serif',
      'color:#3a3327',
      'text-align:center',
      'letter-spacing:.2px',
      'max-width:' + THUMB_W + 'px',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap',
    ].join(';')
    polaroidCaption = cap

    // framing-score stars under the caption
    const stars = document.createElement('div')
    stars.style.cssText = [
      'font:700 10px/1 system-ui,-apple-system,sans-serif',
      `color:${SUN}`,
      'text-align:center',
      'letter-spacing:1px',
      'text-shadow:0 1px 1px rgba(0,0,0,.15)',
    ].join(';')
    polaroidStarsEl = stars

    pol.appendChild(imgWrap)
    pol.appendChild(cap)
    pol.appendChild(stars)
    root.appendChild(pol)
    polaroidEl = pol
    polaroidImgWrap = imgWrap

    // capture surface
    const cv = document.createElement('canvas')
    cv.width = THUMB_W * 2 // a little extra res for retina
    cv.height = THUMB_H * 2
    thumbCanvas = cv
    thumbCtx = cv.getContext('2d')
  }

  // -------------------------------------------------------------------------
  // target lifecycle
  // -------------------------------------------------------------------------
  function startTarget(ctx: GameContext, index: number) {
    currentIndex = index
    inRange = false
    frameTarget = 0
    const t = targets[currentIndex]
    if (!t) return

    if (promptLabelEl) promptLabelEl.textContent = t.label
    updatePromptHint(false)
    showPrompt(true)
    keyArmed = true

    ctx.events.emit('questStart', {
      id: `selfie:${t.id}`,
      label: `Selfie: ${t.label}`,
      kind: 'selfie',
    })
    ctx.hud.toast(`New quest — snap a selfie at the ${t.label}`, 2400)
  }

  function advanceTarget(ctx: GameContext) {
    if (targets.length === 0) return
    const next = (currentIndex + 1) % targets.length
    startTarget(ctx, next)
  }

  function updatePromptHint(near: boolean) {
    if (!promptHintEl) return
    if (near) {
      promptHintEl.textContent = 'press C 📸'
      promptHintEl.style.color = ACCENT
    } else {
      promptHintEl.textContent = 'get closer'
      promptHintEl.style.color = CORAL
    }
  }

  function showPrompt(show: boolean) {
    if (!promptEl) return
    if (show) {
      promptEl.style.display = 'flex'
      promptEl.style.opacity = '1'
      promptEl.style.transform = 'translateX(-50%) translateY(0)'
    } else {
      promptEl.style.opacity = '0'
      promptEl.style.transform = 'translateX(-50%) translateY(8px)'
      const el = promptEl
      window.setTimeout(() => {
        if (el && el.style.opacity === '0') el.style.display = 'none'
      }, 360)
    }
  }

  function showChevron(show: boolean) {
    if (!chevronEl || chevronShown === show) return
    chevronShown = show
    if (show) {
      chevronEl.style.display = 'flex'
      chevronEl.style.opacity = '1'
    } else {
      chevronEl.style.opacity = '0'
      const el = chevronEl
      window.setTimeout(() => {
        if (el && el.style.opacity === '0') el.style.display = 'none'
      }, 320)
    }
  }

  function showRing(show: boolean) {
    if (!ringEl || ringShown === show) return
    ringShown = show
    ringEl.style.opacity = show ? '1' : '0'
  }

  // -------------------------------------------------------------------------
  // the selfie action
  // -------------------------------------------------------------------------
  function takeSelfie(ctx: GameContext) {
    const t = targets[currentIndex]
    if (!t) return

    // framing score: closer + better-centered == more stars (computed before
    // we capture, while the target's screen position is still current).
    const score = framingScore(ctx, t)

    // 1) capture the current rendered frame into the thumbnail.
    captureFrame(ctx)

    // 2) shutter blink (black, quick) + white flash on the rebound.
    shutterAlpha = 0.92
    if (shutterEl) shutterEl.style.opacity = shutterAlpha.toFixed(3)
    flashAlpha = 1.0
    if (flashEl) flashEl.style.opacity = String(flashAlpha)

    // 3) pop the polaroid with develop + sparkle.
    showPolaroid(ctx, t.label, score)

    // 4) audio: a bright shutter-y chirp (reuse existing collect SFX, pitched up).
    ctx.audio.play('collect', { volume: 0.9, rate: 1.5 })

    // 5) reward XP via a `collect` event so Progression banks it uniformly,
    //    then announce quest completion.
    _tmp.copy(ctx.player.obj.position)
    ctx.events.emit('collect', { type: 'selfie', xp: SELFIE_XP, pos: _tmp })
    ctx.events.emit('questComplete', {
      id: `selfie:${t.id}`,
      label: `Selfie: ${t.label}`,
      kind: 'selfie',
      xp: SELFIE_XP,
    })

    const stars = '★'.repeat(score) + '☆'.repeat(3 - score)
    ctx.hud.toast(`Snap! ${t.label}  ${stars}  +${SELFIE_XP} XP`, 2200)

    // 6) lock input through a short settle window, hold the framing, then
    //    advance once the hold elapses (handled in update()).
    keyArmed = false
    pressedC = false
    inRange = false
    snapHoldUntil = ctx.elapsed() + 0.5
    frameTarget = 0
    showPrompt(false)
    showChevron(false)
    showRing(false)
  }

  // How "framed" is the shot? 0..3 stars. Centered + close == better.
  function framingScore(ctx: GameContext, t: SelfieTarget): number {
    // proximity factor (1 at the target, 0 at the radius edge)
    _toTarget.copy(t.position).sub(ctx.player.obj.position)
    const dist = _toTarget.length()
    const prox = THREE.MathUtils.clamp(1 - dist / Math.max(1, t.selfieRadius), 0, 1)
    // centering factor from projected screen position
    _proj.copy(t.position).project(ctx.camera)
    let center = 0
    if (_proj.z < 1) {
      const off = Math.hypot(_proj.x, _proj.y) // 0 == dead center, ~1.4 corner
      center = THREE.MathUtils.clamp(1 - off / 0.9, 0, 1)
    }
    const q = 0.5 * prox + 0.5 * center
    // map quality 0..1 to 1..3 stars (you always get at least one for trying)
    return THREE.MathUtils.clamp(1 + Math.round(q * 2), 1, 3)
  }

  // Copy the live WebGL frame into the 2D thumbnail canvas, then into the <img>.
  // We re-render right before sampling so we don't depend on preserveDrawingBuffer
  // (the GL back-buffer is only guaranteed valid within the same task as render).
  function captureFrame(ctx: GameContext) {
    if (!thumbCtx || !thumbCanvas || !thumbImg) return
    const gl = ctx.renderer.domElement
    try {
      // ensure the back-buffer holds the current frame in THIS call stack
      ctx.renderer.render(ctx.scene, ctx.camera)
      // cover-fit the (usually wide) GL canvas into the 4:3-ish thumb
      const sw = gl.width
      const sh = gl.height
      const dw = thumbCanvas.width
      const dh = thumbCanvas.height
      const scale = Math.max(dw / sw, dh / sh)
      const cw = dw / scale
      const ch = dh / scale
      const sx = (sw - cw) * 0.5
      const sy = (sh - ch) * 0.5
      thumbCtx.drawImage(gl, sx, sy, cw, ch, 0, 0, dw, dh)
      // a tiny warm vignette so it reads as a cozy snapshot
      const grad = thumbCtx.createRadialGradient(
        dw * 0.5,
        dh * 0.5,
        dh * 0.2,
        dw * 0.5,
        dh * 0.5,
        dh * 0.75
      )
      grad.addColorStop(0, 'rgba(0,0,0,0)')
      grad.addColorStop(1, 'rgba(40,28,16,0.22)')
      thumbCtx.fillStyle = grad
      thumbCtx.fillRect(0, 0, dw, dh)
      thumbImg.src = thumbCanvas.toDataURL('image/jpeg', 0.82)
    } catch {
      // Capture can fail on some contexts (tainted/lost). Fall back to a
      // pastel placeholder so the polaroid still feels intentional.
      thumbCtx.fillStyle = css(PAL.skyHorizon)
      thumbCtx.fillRect(0, 0, thumbCanvas.width, thumbCanvas.height)
      thumbImg.src = thumbCanvas.toDataURL('image/jpeg', 0.7)
    }
  }

  function showPolaroid(ctx: GameContext, label: string, score: number) {
    if (!polaroidEl) return
    if (polaroidCaption) polaroidCaption.textContent = label
    if (polaroidStarsEl) polaroidStarsEl.textContent = '★'.repeat(score) + '☆'.repeat(3 - score)
    polaroidEl.style.display = 'flex'

    // start the develop wash opaque, then clear it a beat later
    if (developEl) {
      developEl.style.transition = 'none'
      developEl.style.opacity = '1'
    }

    // pop/slide in on the next frame so the transition actually plays
    const el = polaroidEl
    const dev = developEl
    requestAnimationFrame(() => {
      if (!el) return
      el.style.opacity = '1'
      el.style.transform = 'translate(0,0) scale(1) rotate(3deg)'
      if (dev) {
        dev.style.transition = 'opacity .9s ease'
        dev.style.opacity = '0'
      }
    })

    // sparkle flash (after it lands)
    if (sparkleEl) {
      const spk = sparkleEl
      window.setTimeout(() => {
        if (spk) spk.style.opacity = '1'
        window.setTimeout(() => {
          if (spk) spk.style.opacity = '0'
        }, 480)
      }, 260)
    }

    developClearAt = ctx.elapsed() + 0.95
    // auto-hide a few seconds later (wall-clock so it survives frame hitches)
    polaroidHideAt = ctx.elapsed() + 3.8
  }

  function hidePolaroid() {
    if (!polaroidEl) return
    polaroidEl.style.opacity = '0'
    polaroidEl.style.transform = reduceMotion
      ? 'translate(0,0) scale(1) rotate(3deg)'
      : 'translate(28px,-22px) scale(.72) rotate(8deg)'
    const el = polaroidEl
    window.setTimeout(() => {
      if (el && el.style.opacity === '0') el.style.display = 'none'
    }, 420)
    polaroidHideAt = 0
  }

  return {
    name: 'questSelfie',

    init(ctx: GameContext) {
      ctxRef = ctx
      buildDom(ctx)

      // Single keydown listener; the handler just records intent. We gate on
      // keyArmed + range inside update() so there is no game logic in the event.
      onKeyDown = (e: KeyboardEvent) => {
        if (e.code === 'KeyC') {
          if (e.repeat) return
          pressedC = true
        }
      }
      window.addEventListener('keydown', onKeyDown)

      // Try to adopt the registry immediately (in case Landmarks ran first).
      const raw = (ctx as any).landmarks
      const adopted = adopt(raw)
      if (adopted) {
        targets.length = 0
        for (let i = 0; i < adopted.length; i++) targets.push(adopted[i])
        haveRegistry = true
        startTarget(ctx, 0)
      }
    },

    update(dt: number, ctx: GameContext) {
      pulseT += dt

      // ---- phase 1: wait for the landmark registry, polling at a low rate ----
      if (!haveRegistry) {
        pollAccum += dt
        if (pollAccum >= REGISTRY_POLL) {
          pollAccum = 0
          const adopted = adopt((ctx as any).landmarks)
          if (adopted) {
            targets.length = 0
            for (let i = 0; i < adopted.length; i++) targets.push(adopted[i])
            haveRegistry = true
            startTarget(ctx, 0)
          }
        }
        // still drive the post-snap visuals even pre-registry (harmless; 0s)
        driveBlink(dt)
        driveFrame(dt)
        return
      }

      const inHold = ctx.elapsed() < snapHoldUntil

      // ---- phase 2: active target proximity + selfie trigger ----
      const t = targets[currentIndex]
      if (t && !inHold) {
        _toTarget.copy(t.position).sub(ctx.player.obj.position)
        const dist = _toTarget.length()
        const enterR = t.selfieRadius
        const leaveR = t.selfieRadius * NEAR_HYSTERESIS

        if (!inRange && dist <= enterR) {
          inRange = true
          updatePromptHint(true)
        } else if (inRange && dist > leaveR) {
          inRange = false
          updatePromptHint(false)
        }

        // viewfinder framing ramps up as we approach (full inside the radius)
        const near01 = THREE.MathUtils.clamp(
          1 - (dist - enterR) / Math.max(1, enterR * (RING_LEAD - 1)),
          0,
          1
        )
        frameTarget = inRange ? 1 : near01 * 0.45

        // proximity ring: visible once we're within radius*lead; scale follows
        // the actual distance ratio so it visibly tightens as you arrive.
        const ringActive = dist <= enterR * RING_LEAD
        showRing(ringActive)
        if (ringActive && ringEl) {
          // ratio 1 at the edge, ~0.78 when dead-on the landmark
          const ratio = THREE.MathUtils.clamp(dist / Math.max(1, enterR), 0.55, RING_LEAD)
          const targetScale = 0.78 + (ratio - 0.55) * 0.34
          ringScale += (targetScale - ringScale) * damp(RING_RATE, dt)
          const breathe = inRange ? 1 + Math.sin(pulseT * 3.4) * 0.025 : 1
          ringEl.style.transform = `translate(-50%,-50%) scale(${(ringScale * breathe).toFixed(3)})`
          ringEl.style.borderColor = inRange ? withAlpha(PAL.gem, 0.85) : withAlpha(PAL.gem, 0.5)
        }

        // edge chevron: point at the landmark when it's off-screen / behind.
        updateChevron(ctx, t, dist, dt)

        // consume a C press if we're armed and actually in range
        if (pressedC) {
          pressedC = false
          if (keyArmed && inRange) {
            takeSelfie(ctx)
          }
        }
      } else {
        // either no target or we're in the post-snap hold — keep things quiet
        pressedC = false
        if (inHold) {
          showChevron(false)
          showRing(false)
        }
      }

      // ---- always: drive eased visuals + retire the polaroid on its timer ----
      driveBlink(dt)
      driveFrame(dt)
      // breathe the reticle while the viewfinder is visible
      if (frameReticleEl && frameAmt > 0.02) {
        const s = 1 + Math.sin(pulseT * 3.0) * 0.06
        frameReticleEl.style.transform = `scale(${s.toFixed(3)})`
      }
      if (developEl && developClearAt > 0 && ctx.elapsed() >= developClearAt) {
        developClearAt = 0
        developEl.style.opacity = '0'
      }
      if (polaroidHideAt > 0 && ctx.elapsed() >= polaroidHideAt) hidePolaroid()
    },

    dispose() {
      if (onKeyDown) {
        window.removeEventListener('keydown', onKeyDown)
        onKeyDown = null
      }
      // tear down all DOM we created
      const nodes = [
        promptEl,
        chevronEl,
        frameEl,
        ringEl,
        shutterEl,
        flashEl,
        polaroidEl,
      ] as Array<HTMLElement | null>
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]
        if (n && n.parentElement) n.parentElement.removeChild(n)
      }
      promptEl = null
      promptLabelEl = null
      promptHintEl = null
      chevronEl = null
      chevronArrowEl = null
      chevronDistEl = null
      frameEl = null
      frameReticleEl = null
      ringEl = null
      shutterEl = null
      flashEl = null
      polaroidEl = null
      polaroidImgWrap = null
      polaroidCaption = null
      polaroidStarsEl = null
      developEl = null
      sparkleEl = null
      thumbImg = null
      thumbCanvas = null
      thumbCtx = null
      targets.length = 0
      haveRegistry = false
      currentIndex = -1
      inRange = false
      keyArmed = false
      pressedC = false
      polaroidHideAt = 0
      developClearAt = 0
      flashAlpha = 0
      shutterAlpha = 0
      frameAmt = 0
      frameTarget = 0
      ringShown = false
      chevronShown = false
      snapHoldUntil = 0
      ctxRef = null
    },
  }

  // ----------------------------------------------------------------------
  // eased-visual drivers (closures so they share the animation state above)
  // ----------------------------------------------------------------------

  // dt-invariant black-shutter + white-flash fades.
  function driveBlink(dt: number) {
    if (shutterAlpha > 0.001) {
      shutterAlpha += (0 - shutterAlpha) * damp(SHUTTER_FADE, dt)
      if (shutterAlpha < 0.01) shutterAlpha = 0
      if (shutterEl) shutterEl.style.opacity = shutterAlpha.toFixed(3)
    } else if (shutterAlpha !== 0) {
      shutterAlpha = 0
      if (shutterEl) shutterEl.style.opacity = '0'
    }

    if (flashAlpha > 0.001) {
      flashAlpha += (0 - flashAlpha) * damp(FLASH_FADE, dt)
      if (flashAlpha < 0.01) flashAlpha = 0
      if (flashEl) flashEl.style.opacity = flashAlpha.toFixed(3)
    } else if (flashAlpha !== 0) {
      flashAlpha = 0
      if (flashEl) flashEl.style.opacity = '0'
    }
  }

  // dt-invariant viewfinder framing fade toward frameTarget.
  function driveFrame(dt: number) {
    if (Math.abs(frameTarget - frameAmt) < 0.002 && frameAmt === frameTarget) return
    frameAmt += (frameTarget - frameAmt) * damp(FRAME_RATE, dt)
    if (Math.abs(frameTarget - frameAmt) < 0.003) frameAmt = frameTarget
    if (frameEl) frameEl.style.opacity = frameAmt.toFixed(3)
  }

  // Point the edge chevron at the landmark; hide it when the target is
  // comfortably on-screen (the viewfinder takes over the framing then).
  function updateChevron(
    ctx: GameContext,
    t: SelfieTarget,
    dist: number,
    dt: number
  ) {
    if (!chevronEl) return
    _proj.copy(t.position).project(ctx.camera)
    const onScreen =
      _proj.z < 1 &&
      _proj.x > -0.85 &&
      _proj.x < 0.85 &&
      _proj.y > -0.85 &&
      _proj.y < 0.85

    // Don't crowd the screen once you're basically there / it's on screen.
    // Keep chevron until the proximity ring takes over (ring shows at enterR*RING_LEAD).
    if (inRange || dist <= t.selfieRadius * RING_LEAD) {
      showChevron(false)
      return
    }

    const w = window.innerWidth || 1
    const h = window.innerHeight || 1
    // direction in screen space; flip behind-camera projections.
    let nx = _proj.x
    let ny = _proj.y
    if (_proj.z >= 1) {
      nx = -nx
      ny = -ny
    }
    // clamp the point to a margin-inset rectangle along its own direction.
    const halfW = w * 0.5 - FRAME_MARGIN
    const halfH = h * 0.5 - FRAME_MARGIN
    let sx = nx * (w * 0.5)
    let sy = -ny * (h * 0.5) // DOM y is down
    const mag = Math.max(Math.abs(sx) / halfW, Math.abs(sy) / halfH, 1e-3)
    if (mag > 1) {
      sx /= mag
      sy /= mag
    }
    const px = w * 0.5 + sx
    const py = h * 0.5 + sy

    // ease toward the target position (no jitter)
    if (!chevronShown) {
      chevronX = px
      chevronY = py
    } else {
      const k = damp(CHEVRON_RATE, dt)
      chevronX += (px - chevronX) * k
      chevronY += (py - chevronY) * k
    }
    showChevron(true)
    const angle = Math.atan2(sy, sx) * (180 / Math.PI)
    chevronEl.style.transform = `translate(${chevronX.toFixed(1)}px,${chevronY.toFixed(1)}px) translate(-50%,-50%)`
    if (chevronArrowEl) chevronArrowEl.style.transform = `rotate(${angle.toFixed(1)}deg)`
    if (chevronDistEl) chevronDistEl.textContent = `${Math.round(dist)}m`
  }
}

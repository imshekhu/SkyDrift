import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'

/**
 * Progression — XP, levels, and the level-up upgrade-card flow.
 *
 * Listens to the typed "collect" event, banks XP (scaled by the live xpMult
 * upgrade), and walks a smooth level curve (10 * level^1.5). On a level-up it
 * emits "levelup" and presents a TinySkies-style PAUSE screen: three upgrade
 * CARDS rendered as HUD DOM in ctx.hud.root (pointer-events:auto). Picking a
 * card mutates a SHARED upgrades object on the context so every other system
 * reads the same numbers:
 *
 *   (ctx as any).upgrades = {
 *     speedMult,   // multiply top speed          (Flight / camera read this)
 *     magnet,      // collectible magnet range mult
 *     boostCap,    // boost-meter capacity mult
 *     xpMult,      // XP gain mult
 *     fireMult,    // fire-rate mult
 *   }
 *
 * It also publishes a live readout other HUD can poll:
 *   (ctx as any).progress = { xp, level, xpToNext }
 *
 * At milestone levels it emits "vehicleUnlock" so the vehicle system can swap
 * the player's plane for the next craft (biplane → glider → magic carpet …).
 *
 * POLISH PASS — premium game-feel layer (DOM-only, no Three.js objects):
 *   • An animated level-up CARD picker: a dimmed scrim fades in, a "LEVEL N"
 *     banner pops with a spring, and three cards SLIDE + SCALE in with a
 *     stagger. Cards have crisp hover/lift + press states and a per-card accent
 *     glow. Pointer-events are live only while the picker is shown.
 *   • A satisfying level-up BURST — a ring shock-wave + confetti sparks bloom
 *     out from screen-centre behind the cards — paired with audio.play("levelup").
 *   • Floating "+XP" popups bloom up from screen-centre on every collect, tinted
 *     and sized by the gain, with a crit pop on big pickups.
 *
 * Perf: all the DOM lives in a single overlay that is built lazily and only
 * mounted while a level-up is pending. The "+XP" popups reuse a tiny pooled
 * layer of <span> nodes (no per-popup allocation, capped count). update() does
 * almost nothing on the steady state but service a small deferred queue and tick
 * a CSS-free popup timeline — zero per-frame heap allocation, no Three.js work.
 */

/** Shared upgrades record other systems read off (ctx as any).upgrades. */
export interface Upgrades {
  speedMult: number
  magnet: number
  boostCap: number
  xpMult: number
  fireMult: number
}

/** Live XP readout other HUD reads off (ctx as any).progress. */
export interface Progress {
  xp: number
  level: number
  xpToNext: number
}

type UpgradeId = 'speed' | 'magnet' | 'boost' | 'xp' | 'fire'

interface UpgradeDef {
  id: UpgradeId
  icon: string
  title: string
  /** short flavour line shown under the title */
  blurb: string
  /** apply one rank of this upgrade to the shared record */
  apply: (u: Upgrades) => void
  /** accent colour (sRGB hex string) for the card glow */
  accent: string
}

// Vehicles unlocked at these levels (1-indexed milestones).
const VEHICLE_UNLOCKS: Array<{ level: number; id: string; label: string }> = [
  { level: 3, id: 'glider', label: 'Sky Glider' },
  { level: 7, id: 'seaplane', label: 'Pontoon Seaplane' },
  { level: 12, id: 'carpet', label: 'Magic Carpet' },
]

// Convert a THREE.Color token to a CSS rgb() string once (no per-frame work).
const css = (c: { r: number; g: number; b: number }): string =>
  `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`
// …and an rgba() variant for soft glows.
const cssa = (c: { r: number; g: number; b: number }, a: number): string =>
  `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`

// One-time stylesheet injection key — keyframes live here so cards/popups can
// animate purely on the GPU compositor with zero per-frame JS.
const STYLE_ID = 'skydrift-progression-style'

export function createProgressionSystem(): GameSystem {
  // --- canonical shared state (also mirrored onto the context in init) ---
  const upgrades: Upgrades = {
    speedMult: 1,
    magnet: 1,
    boostCap: 1,
    xpMult: 1,
    fireMult: 1,
  }
  const progress: Progress = { xp: 0, level: 1, xpToNext: xpForLevel(1) }

  // total XP banked across the run, and XP spent reaching the current level.
  let totalXp = 0
  let levelFloor = 0 // total XP at the start of the current level

  // event teardown + DOM handles
  let offCollect: (() => void) | null = null
  let overlay: HTMLDivElement | null = null
  let popupLayer: HTMLDivElement | null = null
  let ctxRef: GameContext | null = null

  // A queue of pending level-up screens. We only ever show one at a time; if
  // several levels are crossed in a single frame (big pickup), they stack.
  let pendingLevels = 0
  let cardScreenOpen = false

  // module-style colour cache (computed once at first build)
  const ACCENT = {
    speed: css(PAL.planeBody),
    magnet: css(PAL.gem),
    boost: css(PAL.planeWing),
    xp: css(PAL.skyHorizon),
    fire: css(PAL.sun),
  }
  // soft glow tints used by the "+XP" popups
  const XP_TINT = css(PAL.skyHorizon)
  const XP_TINT_BIG = css(PAL.gem)

  // --- the upgrade catalogue (each pick is one "rank") ---
  const CATALOG: UpgradeDef[] = [
    {
      id: 'speed',
      icon: '✈',
      title: '+ Top Speed',
      blurb: 'Cruise & boost a little faster.',
      apply: (u) => {
        u.speedMult += 0.08
      },
      accent: ACCENT.speed,
    },
    {
      id: 'magnet',
      icon: '🧲',
      title: '+ Magnet Range',
      blurb: 'Pull collectibles from farther away.',
      apply: (u) => {
        u.magnet += 0.18
      },
      accent: ACCENT.magnet,
    },
    {
      id: 'boost',
      icon: '⚡',
      title: '+ Boost Capacity',
      blurb: 'A bigger boost meter to burn.',
      apply: (u) => {
        u.boostCap += 0.15
      },
      accent: ACCENT.boost,
    },
    {
      id: 'xp',
      icon: '✦',
      title: '+ XP Gain',
      blurb: 'Earn more from every pickup.',
      apply: (u) => {
        u.xpMult += 0.12
      },
      accent: ACCENT.xp,
    },
    {
      id: 'fire',
      icon: '◎',
      title: '+ Fire Rate',
      blurb: 'Sling paintballs more often.',
      apply: (u) => {
        u.fireMult += 0.12
      },
      accent: ACCENT.fire,
    },
  ]

  // 10 * level^1.5, rounded — gentle early curve, steady ramp later.
  function xpForLevel(level: number): number {
    return Math.max(1, Math.round(10 * Math.pow(level, 1.5)))
  }

  // ---------------------------------------------------------------------------
  // One-time keyframe stylesheet. Animations run on the compositor; JS never
  // touches them after spawn. Injected once on first build, removed on dispose.
  // ---------------------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return
    const s = document.createElement('style')
    s.id = STYLE_ID
    s.textContent = `
@keyframes sd-scrim-in{from{opacity:0}to{opacity:1}}
@keyframes sd-banner-in{
  0%{opacity:0;transform:translateY(14px) scale(.82)}
  62%{opacity:1;transform:translateY(0) scale(1.06)}
  100%{opacity:1;transform:translateY(0) scale(1)}
}
@keyframes sd-card-in{
  0%{opacity:0;transform:translateY(34px) scale(.86) rotateX(12deg)}
  70%{opacity:1;transform:translateY(-4px) scale(1.02) rotateX(0deg)}
  100%{opacity:1;transform:translateY(0) scale(1) rotateX(0deg)}
}
@keyframes sd-card-out{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.9)}}
@keyframes sd-ring{
  0%{opacity:.0;transform:translate(-50%,-50%) scale(.2)}
  18%{opacity:.85}
  100%{opacity:0;transform:translate(-50%,-50%) scale(2.6)}
}
@keyframes sd-spark{
  0%{opacity:1;transform:translate(-50%,-50%) translate(0,0) scale(1)}
  100%{opacity:0;transform:translate(-50%,-50%) translate(var(--dx),var(--dy)) scale(.3)}
}
@keyframes sd-xp{
  0%{opacity:0;transform:translate(-50%,-50%) translateY(6px) scale(.7)}
  16%{opacity:1;transform:translate(-50%,-50%) translateY(0) scale(1.12)}
  30%{transform:translate(-50%,-50%) translateY(-6px) scale(1)}
  100%{opacity:0;transform:translate(-50%,-50%) translateY(-72px) scale(.92)}
}
@keyframes sd-icon-bob{
  0%,100%{transform:translateY(0)}
  50%{transform:translateY(-3px)}
}
.sd-card{transition:transform .14s cubic-bezier(.2,.8,.2,1),box-shadow .14s ease,filter .14s ease}
.sd-card:hover{transform:translateY(-7px) scale(1.035)}
.sd-card:active{transform:translateY(-2px) scale(.985);transition-duration:.05s}
@media (prefers-reduced-motion: reduce){
  .sd-card,.sd-card:hover,.sd-card:active{transform:none}
}
`
    document.head.appendChild(s)
  }

  // ---- XP intake ----
  function onCollect(payload?: any) {
    if (!ctxRef) return
    const raw = payload && typeof payload.xp === 'number' ? payload.xp : 1
    const gained = Math.max(0, raw) * upgrades.xpMult
    if (gained <= 0) return
    totalXp += gained

    // floating "+XP" feedback — purely cosmetic, pooled, capped.
    spawnXpPopup(gained)

    // Resolve as many level-ups as this banked XP allows.
    while (totalXp - levelFloor >= progress.xpToNext) {
      levelFloor += progress.xpToNext
      progress.level += 1
      pendingLevels += 1
      progress.xpToNext = xpForLevel(progress.level)
      ctxRef.events.emit('levelup', { level: progress.level })

      // milestone vehicle unlocks
      for (let i = 0; i < VEHICLE_UNLOCKS.length; i++) {
        const v = VEHICLE_UNLOCKS[i]
        if (v.level === progress.level) {
          ctxRef.events.emit('vehicleUnlock', { id: v.id, label: v.label })
          ctxRef.hud.toast(`Unlocked: ${v.label}`, 2600)
        }
      }
    }

    // keep the live readout fresh for other HUD widgets
    progress.xp = totalXp - levelFloor
  }

  // ---------------------------------------------------------------------------
  // Floating "+XP" popups — a pooled layer of absolutely-positioned spans that
  // bloom up from screen-centre. Each span is reused; we cap how many animate at
  // once so a magnet-vacuum frame can't flood the DOM. No per-popup allocation.
  // ---------------------------------------------------------------------------
  const POP_POOL = 10
  const popSpans: HTMLSpanElement[] = []
  const popFree: boolean[] = []
  let popCursor = 0

  function ensurePopupLayer(ctx: GameContext) {
    if (popupLayer) return
    ensureStyle()
    const layer = document.createElement('div')
    layer.style.cssText = [
      'position:absolute',
      'inset:0',
      'pointer-events:none',
      'overflow:hidden',
      'z-index:14',
      'font-family:system-ui,-apple-system,sans-serif',
    ].join(';')
    ctx.hud.root.appendChild(layer)
    for (let i = 0; i < POP_POOL; i++) {
      const sp = document.createElement('span')
      sp.style.cssText = [
        'position:absolute',
        'left:50%',
        'top:46%',
        'opacity:0',
        'font-weight:900',
        'white-space:nowrap',
        'will-change:transform,opacity',
        'text-shadow:0 2px 8px rgba(0,0,0,.5)',
        'letter-spacing:.3px',
      ].join(';')
      layer.appendChild(sp)
      popSpans.push(sp)
      popFree.push(true)
    }
    popupLayer = layer
  }

  function spawnXpPopup(gain: number) {
    if (!ctxRef || !popupLayer) return
    // find a free span (round-robin; steal the oldest if all busy).
    let idx = -1
    for (let n = 0; n < POP_POOL; n++) {
      const i = (popCursor + n) % POP_POOL
      if (popFree[i]) {
        idx = i
        break
      }
    }
    if (idx < 0) idx = popCursor % POP_POOL
    popCursor = (idx + 1) % POP_POOL

    const sp = popSpans[idx]
    popFree[idx] = false

    const big = gain >= 5
    const huge = gain >= 12
    const shown = Math.round(gain)
    sp.textContent = `+${shown} XP`
    // jitter horizontal start so a burst of pickups fans out a little.
    const jx = 50 + (ctxRef.rand() * 26 - 13)
    const jy = 44 + (ctxRef.rand() * 8 - 4)
    sp.style.left = `${jx}%`
    sp.style.top = `${jy}%`
    sp.style.fontSize = huge ? '30px' : big ? '24px' : '19px'
    const tint = big ? XP_TINT_BIG : XP_TINT
    sp.style.color = '#fff'
    sp.style.textShadow = `0 2px 8px rgba(0,0,0,.5),0 0 14px ${tint},0 0 26px ${big ? tint : 'transparent'}`

    // restart the animation deterministically (clear → reflow → set).
    sp.style.animation = 'none'
    // force reflow so the browser registers the cleared animation
    void sp.offsetWidth
    const dur = huge ? 1.15 : 0.95
    sp.style.animation = `sd-xp ${dur}s cubic-bezier(.2,.7,.2,1) forwards`

    // free the span after the animation ends (single listener, self-removing).
    const onEnd = () => {
      sp.removeEventListener('animationend', onEnd)
      sp.style.opacity = '0'
      popFree[idx] = true
    }
    sp.addEventListener('animationend', onEnd)
  }

  // ---- card screen lifecycle ----

  // Pick three distinct upgrades (seeded RNG → deterministic offers).
  function rollChoices(ctx: GameContext, out: UpgradeDef[]) {
    out.length = 0
    // simple Fisher-Yates on indices using the seeded RNG, take first 3
    const idx = [0, 1, 2, 3, 4]
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(ctx.rand() * (i + 1))
      const t = idx[i]
      idx[i] = idx[j]
      idx[j] = t
    }
    const n = Math.min(3, CATALOG.length)
    for (let k = 0; k < n; k++) out.push(CATALOG[idx[k]])
  }

  const _choices: UpgradeDef[] = []

  function buildOverlay(): HTMLDivElement {
    ensureStyle()
    const el = document.createElement('div')
    el.id = 'progression-cards'
    el.style.cssText = [
      'position:absolute',
      'inset:0',
      'display:none',
      'align-items:center',
      'justify-content:center',
      'flex-direction:column',
      'gap:22px',
      'pointer-events:auto',
      'background:radial-gradient(120% 120% at 50% 30%,rgba(10,16,38,.42),rgba(6,10,26,.80))',
      'backdrop-filter:blur(4px)',
      '-webkit-backdrop-filter:blur(4px)',
      'padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom))',
      'box-sizing:border-box',
      'z-index:20',
      'font-family:system-ui,-apple-system,sans-serif',
      'color:#fff',
      'user-select:none',
      '-webkit-user-select:none',
      '-webkit-tap-highlight-color:transparent',
      'perspective:900px',
    ].join(';')
    return el
  }

  // Spawn the celebratory burst (ring + sparks) into the overlay, behind cards.
  // All nodes self-remove on animationend — capped count, no Three.js, pooled
  // by the short-lived nature of the burst (only on screen open).
  function spawnBurst(ctx: GameContext, host: HTMLElement, accent: string) {
    const fx = document.createElement('div')
    fx.style.cssText =
      'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:0'
    host.appendChild(fx)

    // shock-wave ring
    const ring = document.createElement('div')
    ring.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:42%',
      'width:120px',
      'height:120px',
      'border-radius:50%',
      `border:4px solid ${accent}`,
      'box-shadow:0 0 30px ' + accent,
      'animation:sd-ring .85s cubic-bezier(.1,.7,.2,1) forwards',
    ].join(';')
    fx.appendChild(ring)

    // confetti sparks fanning out
    const SPARKS = 14
    const tints = [accent, XP_TINT, XP_TINT_BIG, '#ffffff']
    for (let i = 0; i < SPARKS; i++) {
      const a = (i / SPARKS) * Math.PI * 2 + ctx.rand() * 0.4
      const dist = 90 + ctx.rand() * 120
      const dx = Math.cos(a) * dist
      const dy = Math.sin(a) * dist
      const sz = 5 + ctx.rand() * 6
      const sp = document.createElement('div')
      sp.style.cssText = [
        'position:absolute',
        'left:50%',
        'top:42%',
        `width:${sz}px`,
        `height:${sz}px`,
        'border-radius:2px',
        `background:${tints[i % tints.length]}`,
        `--dx:${dx.toFixed(1)}px`,
        `--dy:${dy.toFixed(1)}px`,
        `animation:sd-spark ${(0.6 + ctx.rand() * 0.4).toFixed(2)}s ease-out forwards`,
        `box-shadow:0 0 8px ${tints[i % tints.length]}`,
      ].join(';')
      fx.appendChild(sp)
    }

    // tear the whole fx layer down once the longest spark finishes
    const kill = () => {
      ring.removeEventListener('animationend', kill)
      fx.parentElement?.removeChild(fx)
    }
    // ring is the longest-lived element; key the teardown off it.
    ring.addEventListener('animationend', kill)
  }

  // Render the current offer into the overlay. Each card resolves the screen.
  function openCardScreen(ctx: GameContext) {
    if (!overlay) {
      overlay = buildOverlay()
      ctx.hud.root.appendChild(overlay)
    }
    cardScreenOpen = true
    rollChoices(ctx, _choices)

    // clear previous content
    while (overlay.firstChild) overlay.removeChild(overlay.firstChild)

    // scrim is the overlay background itself; fade it in.
    overlay.style.animation = 'sd-scrim-in .26s ease forwards'

    // celebratory burst layered behind everything
    const burstAccent = _choices.length > 0 ? _choices[0].accent : ACCENT.xp
    spawnBurst(ctx, overlay, burstAccent)

    const header = document.createElement('div')
    header.style.cssText = [
      'text-align:center',
      'text-shadow:0 2px 6px rgba(0,0,0,.55)',
      'margin-bottom:2px',
      'position:relative',
      'z-index:1',
      'animation:sd-banner-in .5s cubic-bezier(.2,.9,.25,1) both',
    ].join(';')
    const kicker = document.createElement('div')
    kicker.textContent = 'LEVEL UP'
    kicker.style.cssText = [
      'font-size:13px',
      'font-weight:800',
      'letter-spacing:3px',
      `color:${ACCENT.xp}`,
      'opacity:.95',
      'margin-bottom:2px',
    ].join(';')
    const lvl = document.createElement('div')
    lvl.textContent = `Level ${progress.level}`
    lvl.style.cssText = 'font-size:34px;font-weight:900;letter-spacing:.5px'
    const sub = document.createElement('div')
    sub.textContent = 'Choose an upgrade'
    sub.style.cssText = 'font-size:15px;opacity:.82;margin-top:3px;font-weight:600'
    header.appendChild(kicker)
    header.appendChild(lvl)
    header.appendChild(sub)
    overlay.appendChild(header)

    const row = document.createElement('div')
    row.style.cssText = [
      'display:flex',
      'gap:16px',
      'flex-wrap:wrap',
      'justify-content:center',
      'max-width:580px',
      'width:100%',
      'position:relative',
      'z-index:1',
    ].join(';')
    overlay.appendChild(row)

    for (let i = 0; i < _choices.length; i++) {
      const def = _choices[i]
      // stagger the slide-in so the three cards cascade in.
      row.appendChild(makeCard(ctx, def, 0.12 + i * 0.09))
    }

    overlay.style.display = 'flex'
    ctx.audio.play('levelup', { volume: 0.95 })
  }

  function makeCard(ctx: GameContext, def: UpgradeDef, delay: number): HTMLElement {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'sd-card'
    card.style.cssText = [
      'flex:1 1 158px',
      'min-width:158px',
      'max-width:178px',
      'cursor:pointer',
      'border:0',
      'outline:0',
      `border-top:3px solid ${def.accent}`,
      'border-radius:18px',
      'padding:20px 14px 16px',
      'background:linear-gradient(180deg,rgba(22,30,58,.94),rgba(13,19,40,.94))',
      `box-shadow:0 12px 30px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.07),0 0 26px -6px ${def.accent}`,
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'gap:9px',
      'color:#fff',
      'text-align:center',
      'font-family:inherit',
      'will-change:transform,opacity',
      // entrance (with stagger); the .sd-card class owns the hover/press transition.
      `animation:sd-card-in .5s cubic-bezier(.18,.9,.24,1) ${delay.toFixed(2)}s both`,
    ].join(';')

    // accent glow plate behind the icon
    const iconWrap = document.createElement('div')
    iconWrap.style.cssText = [
      'width:54px',
      'height:54px',
      'border-radius:14px',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      `background:radial-gradient(circle at 50% 40%,${cssa(toColor(def.accent), 0.32)},rgba(255,255,255,.03))`,
      `box-shadow:inset 0 0 0 1px ${cssa(toColor(def.accent), 0.4)}`,
    ].join(';')
    const icon = document.createElement('div')
    icon.textContent = def.icon
    icon.style.cssText = [
      'font-size:30px',
      'line-height:1',
      `color:${def.accent}`,
      `text-shadow:0 0 14px ${def.accent}`,
      'animation:sd-icon-bob 2.4s ease-in-out infinite',
    ].join(';')
    iconWrap.appendChild(icon)

    const title = document.createElement('div')
    title.textContent = def.title
    title.style.cssText = 'font-size:16px;font-weight:800'
    const blurb = document.createElement('div')
    blurb.textContent = def.blurb
    blurb.style.cssText =
      'font-size:12.5px;opacity:.78;line-height:1.35;font-weight:500'

    // a thin "pick" chip footer for affordance
    const pick = document.createElement('div')
    pick.textContent = 'TAP TO PICK'
    pick.style.cssText = [
      'margin-top:4px',
      'font-size:10px',
      'font-weight:800',
      'letter-spacing:1.5px',
      `color:${def.accent}`,
      'opacity:.85',
    ].join(';')

    card.appendChild(iconWrap)
    card.appendChild(title)
    card.appendChild(blurb)
    card.appendChild(pick)

    // hover boosts the accent glow (lift/scale handled by the .sd-card CSS).
    const onEnter = () => {
      card.style.boxShadow = `0 18px 40px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.12),0 0 40px -4px ${def.accent}`
    }
    const onLeave = () => {
      card.style.boxShadow = `0 12px 30px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.07),0 0 26px -6px ${def.accent}`
    }
    card.addEventListener('pointerenter', onEnter)
    card.addEventListener('pointerleave', onLeave)
    card.addEventListener('click', () => pickCard(ctx, def, card))

    return card
  }

  function pickCard(ctx: GameContext, def: UpgradeDef, card: HTMLElement) {
    if (!cardScreenOpen) return // guard against double-tap
    cardScreenOpen = false // lock immediately so a second tap is ignored
    def.apply(upgrades)
    ctx.audio.play('collect', { volume: 0.85, rate: 1.18 })
    ctx.hud.toast(`${def.title.replace(/^\+\s*/, '')} up!`, 1400)

    // quick "chosen" pop on the picked card, fade the rest, then close.
    card.style.animation = 'none'
    void (card as HTMLElement).offsetWidth
    card.style.transform = 'translateY(-10px) scale(1.08)'
    card.style.boxShadow = `0 20px 46px rgba(0,0,0,.5),0 0 0 2px ${def.accent},0 0 50px -2px ${def.accent}`
    if (overlay) overlay.style.pointerEvents = 'none' // no more taps mid-close

    if (typeof window !== 'undefined') {
      window.setTimeout(() => closeCardScreen(), 180)
    } else {
      closeCardScreen()
    }
  }

  function closeCardScreen() {
    cardScreenOpen = false
    if (overlay) {
      overlay.style.display = 'none'
      overlay.style.pointerEvents = 'auto'
      overlay.style.animation = 'none'
      while (overlay.firstChild) overlay.removeChild(overlay.firstChild)
    }
  }

  // Resolve a CSS rgb()/hex string back to a {r,g,b} 0..1 triple so the per-card
  // glow helpers can build rgba() strings. Cached-free but only called at build
  // time (screen open), never per-frame.
  function toColor(s: string): { r: number; g: number; b: number } {
    // rgb(r,g,b)
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(s)
    if (m) {
      return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255 }
    }
    // #rrggbb
    if (s[0] === '#' && s.length >= 7) {
      return {
        r: parseInt(s.slice(1, 3), 16) / 255,
        g: parseInt(s.slice(3, 5), 16) / 255,
        b: parseInt(s.slice(5, 7), 16) / 255,
      }
    }
    return { r: 1, g: 1, b: 1 }
  }

  return {
    name: 'progression',

    init(ctx: GameContext) {
      ctxRef = ctx
      ensureStyle()
      ensurePopupLayer(ctx)

      // Publish shared records — create if absent, otherwise adopt existing so
      // a system that ran first (and seeded defaults) isn't clobbered.
      const anyCtx = ctx as any
      if (anyCtx.upgrades) {
        const ex = anyCtx.upgrades as Partial<Upgrades>
        upgrades.speedMult = ex.speedMult ?? upgrades.speedMult
        upgrades.magnet = ex.magnet ?? upgrades.magnet
        upgrades.boostCap = ex.boostCap ?? upgrades.boostCap
        upgrades.xpMult = ex.xpMult ?? upgrades.xpMult
        upgrades.fireMult = ex.fireMult ?? upgrades.fireMult
      }
      anyCtx.upgrades = upgrades
      anyCtx.progress = progress

      offCollect = ctx.events.on('collect', onCollect)
    },

    update(_dt: number, ctx: GameContext) {
      // Steady state: nothing to do. Only act when a level-up is queued and no
      // card screen is currently open. (No allocation on the hot path.)
      if (pendingLevels > 0 && !cardScreenOpen) {
        pendingLevels -= 1
        openCardScreen(ctx)
      }
    },

    dispose() {
      if (offCollect) {
        offCollect()
        offCollect = null
      }
      if (overlay) {
        overlay.parentElement?.removeChild(overlay)
        overlay = null
      }
      if (popupLayer) {
        popupLayer.parentElement?.removeChild(popupLayer)
        popupLayer = null
      }
      popSpans.length = 0
      popFree.length = 0
      popCursor = 0
      const styleEl = document.getElementById(STYLE_ID)
      if (styleEl) styleEl.parentElement?.removeChild(styleEl)
      _choices.length = 0
      ctxRef = null
      cardScreenOpen = false
      pendingLevels = 0
    },
  }
}

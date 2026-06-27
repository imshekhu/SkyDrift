// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — game flow (start screen · pause · back to menu)
//
// A pure-DOM overlay over the WebGL canvas, with three states:
//   'menu'    — the title/start screen (a Start button); the loop animates a slow
//               cinematic backdrop behind it.
//   'playing' — full game; a small pause button (or Esc / P) is available.
//   'paused'  — a pause overlay (Resume · Main Menu); the loop freezes the sim.
//
// main.ts queries the state each frame to decide what to run, and we hide the HUD
// behind the menu/pause screens. Overlays live in their own top container so the
// HUD can be hidden independently. Zero per-frame cost (event-driven only).
// ─────────────────────────────────────────────────────────────────────────────

export type FlowState = 'menu' | 'playing' | 'paused'

export interface GameFlow {
  getState(): FlowState
  isPlaying(): boolean
  isMenu(): boolean
  isPaused(): boolean
}

export interface GameFlowOpts {
  /** the HUD root — hidden while in the menu/pause screens */
  hudRoot: HTMLElement
  /** fired on every transition (e.g. unlock audio on play, hush engine on pause) */
  onStateChange?(next: FlowState, prev: FlowState): void
}

const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif"

export function createGameFlow(opts: GameFlowOpts): GameFlow {
  const { hudRoot } = opts
  let state: FlowState = 'menu'

  // --- one-time stylesheet ---------------------------------------------------
  if (!document.getElementById('sd-flow-kf')) {
    const st = document.createElement('style')
    st.id = 'sd-flow-kf'
    st.textContent = `
      @keyframes sdFlowIn { from { opacity:0 } to { opacity:1 } }
      @keyframes sdTitlePop { 0%{transform:translateY(10px) scale(.97);opacity:0} 100%{transform:none;opacity:1} }
      .sd-btn { pointer-events:auto; cursor:pointer; border:none; font-family:${FONT};
        transition:transform .12s ease, box-shadow .12s ease, filter .12s ease; }
      .sd-btn:hover { transform:translateY(-2px); filter:brightness(1.06) }
      .sd-btn:active { transform:translateY(0) scale(.97) }
      .sd-pausebtn:hover { transform:translateY(-2px); filter:brightness(1.12) }
      .sd-pausebtn:active { transform:scale(.94) }`
    document.head.appendChild(st)
  }

  const root = document.createElement('div')
  root.style.cssText = `position:fixed;inset:0;z-index:60;pointer-events:none;font-family:${FONT};`
  document.body.appendChild(root)

  // --- button factories ------------------------------------------------------
  const primaryBtn = (label: string) => {
    const b = document.createElement('button')
    b.className = 'sd-btn'
    b.innerHTML = label
    b.style.cssText = `margin:6px;padding:14px 36px;border-radius:999px;font-size:19px;font-weight:700;
      color:#3a2418;background:linear-gradient(180deg,#ffc18a,#ff7a5c);
      box-shadow:0 10px 24px rgba(255,110,80,.45), inset 0 1px 0 rgba(255,255,255,.55);`
    return b
  }
  const ghostBtn = (label: string) => {
    const b = document.createElement('button')
    b.className = 'sd-btn'
    b.innerHTML = label
    b.style.cssText = `margin:6px;padding:12px 28px;border-radius:999px;font-size:16px;font-weight:600;
      color:#fdf6e3;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.28);
      box-shadow:0 4px 14px rgba(0,0,0,.25);`
    return b
  }
  const scrim = (opacity: number) => {
    const d = document.createElement('div')
    d.style.cssText = `position:absolute;inset:0;display:none;flex-direction:column;align-items:center;
      justify-content:center;text-align:center;padding:24px;box-sizing:border-box;
      background:radial-gradient(ellipse at center, rgba(8,16,34,${opacity * 0.65}), rgba(6,12,28,${opacity}));
      -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);animation:sdFlowIn .25s ease;`
    return d
  }

  // --- START SCREEN ----------------------------------------------------------
  const startScreen = scrim(0.5)
  const title = document.createElement('div')
  title.textContent = 'SkyDrift'
  title.style.cssText = `font-size:clamp(44px,12vw,72px);font-weight:800;letter-spacing:2px;color:#fff;
    text-shadow:0 2px 0 rgba(0,0,0,.25), 0 0 28px rgba(120,200,255,.55);animation:sdTitlePop .5s ease both;`
  const tagline = document.createElement('div')
  tagline.textContent = 'Fly a tiny world of forests, rivers & wonders'
  tagline.style.cssText = `margin:8px 0 28px;font-size:clamp(14px,3.4vw,18px);color:#e3eef8;opacity:.92;`
  const startBtn = primaryBtn('▶&nbsp; Start Flight')
  const controls = document.createElement('div')
  controls.innerHTML =
    '<b>W/S</b> throttle &nbsp; <b>A/D</b> bank &nbsp; <b>↑</b> climb &nbsp; <b>Space</b> fire &nbsp; <b>Esc</b> pause'
  controls.style.cssText = `margin-top:28px;font-size:13px;color:#cdd9e6;opacity:.78;line-height:1.6;`
  startScreen.append(title, tagline, startBtn, controls)

  // --- PAUSE SCREEN ----------------------------------------------------------
  const pauseScreen = scrim(0.52)
  const pTitle = document.createElement('div')
  pTitle.textContent = 'Paused'
  pTitle.style.cssText = `font-size:clamp(34px,9vw,48px);font-weight:800;color:#fff;
    text-shadow:0 0 22px rgba(120,200,255,.4);margin-bottom:20px;`
  const row = document.createElement('div')
  row.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;align-items:center;'
  const resumeBtn = primaryBtn('▶&nbsp; Resume')
  const menuBtn = ghostBtn('⤺&nbsp; Main Menu')
  row.append(resumeBtn, menuBtn)
  pauseScreen.append(pTitle, row)

  // --- PAUSE BUTTON (in-play) ------------------------------------------------
  const pauseBtn = document.createElement('button')
  pauseBtn.className = 'sd-btn sd-pausebtn'
  pauseBtn.setAttribute('aria-label', 'Pause')
  pauseBtn.innerHTML = '❚❚'
  pauseBtn.style.cssText = `position:absolute;top:calc(env(safe-area-inset-top,0px) + 12px);right:72px;
    display:none;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;
    font-size:13px;font-weight:700;letter-spacing:1px;color:#fff;
    background:rgba(18,28,48,.5);border:1px solid rgba(255,255,255,.28);box-shadow:0 4px 14px rgba(0,0,0,.3);`

  root.append(startScreen, pauseScreen, pauseBtn)

  // --- state machine ---------------------------------------------------------
  function apply() {
    startScreen.style.display = state === 'menu' ? 'flex' : 'none'
    pauseScreen.style.display = state === 'paused' ? 'flex' : 'none'
    pauseBtn.style.display = state === 'playing' ? 'flex' : 'none'
    hudRoot.style.visibility = state === 'playing' ? 'visible' : 'hidden'
  }
  function setState(next: FlowState) {
    if (next === state) return
    const prev = state
    state = next
    apply()
    opts.onStateChange?.(next, prev)
  }

  startBtn.onclick = () => setState('playing')
  resumeBtn.onclick = () => setState('playing')
  menuBtn.onclick = () => setState('menu')
  pauseBtn.onclick = () => setState('paused')

  // Esc / P toggle pause while playing or paused (ignored on the title screen).
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' && e.code !== 'KeyP') return
    if (state === 'playing') {
      e.preventDefault()
      setState('paused')
    } else if (state === 'paused') {
      e.preventDefault()
      setState('playing')
    }
  })

  apply() // initial render = menu

  return {
    getState: () => state,
    isPlaying: () => state === 'playing',
    isMenu: () => state === 'menu',
    isPaused: () => state === 'paused',
  }
}

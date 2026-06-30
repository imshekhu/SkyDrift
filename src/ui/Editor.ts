import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Planet } from '../core/types'
import type { GameFlow } from './GameFlow'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Designer Editor
//
// A free-look "world editor" overlay for level design. Toggle with the 📍 button
// (top-left) or the `E` key. While active:
//   • Left-drag      orbit the planet
//   • Scroll wheel   zoom in / out
//   • Right-click    drop a labelled PIN on the surface (prompts for a name)
//
// Pins live in the scene as little posts + floating HTML labels, persist to
// localStorage, and can be copied as JSON (lat/lon + direction) so they can be
// handed to chat ("do X at <pin>"). The sim is frozen while the editor is open;
// main.ts renders the orbit view instead of the chase camera.
//
// Public API (also exposed on window.__sdEditor for tooling):
//   isActive() · toggle() · open() · close() · update(dt)
//   addPin(dir, label) · listPins() · clearPins()
// ─────────────────────────────────────────────────────────────────────────────

export interface EditorPin {
  id: number
  label: string
  /** unit direction from the planet centre to the pin */
  dir: THREE.Vector3
  group: THREE.Group
  el: HTMLDivElement
}

export interface EditorOpts {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  planet: Planet
  flow: GameFlow
  hudRoot: HTMLElement
}

export interface Editor {
  isActive(): boolean
  toggle(): void
  open(): void
  close(): void
  update(dt: number): void
  addPin(dir: THREE.Vector3, label: string): EditorPin
  listPins(): Array<{ label: string; lat: number; lon: number; dir: [number, number, number] }>
  clearPins(): void
}

const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif"
const STORE_KEY = 'sd-editor-pins'

const latOf = (d: THREE.Vector3) => (Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)) * 180) / Math.PI
const lonOf = (d: THREE.Vector3) => (Math.atan2(d.z, d.x) * 180) / Math.PI

export function createEditor(opts: EditorOpts): Editor {
  const { scene, camera, renderer, planet, flow, hudRoot } = opts
  const R = planet.radius
  const canvas = renderer.domElement

  let active = false
  let controls: OrbitControls | null = null
  let nextId = 1
  const pins: EditorPin[] = []

  // Shared marker geometry/material (cheap; reused per pin). A little FLAG: a thin
  // pole standing on the surface (base at local y=0, +Y = the surface normal) with
  // a red pennant near the top. DoubleSide so the banner shows from either face.
  const POLE_H = R * 0.18 // flagpole height above the surface (HUGE — easy to see/label)
  const FLAG_W = R * 0.11 // pennant reach (out along +X)
  const FLAG_H = R * 0.07 // pennant height
  const PIN_TOP = POLE_H // top of the pole (for the floating HTML label offset)
  const poleGeo = new THREE.CylinderGeometry(R * 0.004, R * 0.004, POLE_H, 8)
  poleGeo.translate(0, POLE_H / 2, 0) // base on the surface, pole pointing outward
  const flagGeo = new THREE.BufferGeometry()
  // a right-pointing triangular pennant attached to the top of the pole
  flagGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [0, POLE_H, 0, 0, POLE_H - FLAG_H, 0, FLAG_W, POLE_H - FLAG_H * 0.5, 0],
      3
    )
  )
  flagGeo.computeVertexNormals()
  const poleMat = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 })
  const headMat = new THREE.MeshBasicMaterial({ color: 0xff4d3d, side: THREE.DoubleSide })

  const pinsGroup = new THREE.Group()
  pinsGroup.name = 'editor-pins'
  scene.add(pinsGroup)

  // ── UI layers ──────────────────────────────────────────────────────────────
  // Label layer (projected HTML tags) — non-interactive, sits over the canvas.
  const labelLayer = document.createElement('div')
  labelLayer.style.cssText = `position:fixed;inset:0;z-index:62;pointer-events:none;font-family:${FONT};`
  document.body.appendChild(labelLayer)

  // Toggle button — always visible so you can enter the editor from any screen.
  const toggleBtn = document.createElement('button')
  toggleBtn.innerHTML = '📍'
  toggleBtn.title = 'Designer view (E)'
  toggleBtn.style.cssText = `position:fixed;top:calc(env(safe-area-inset-top,0px) + 12px);left:12px;z-index:70;
    width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.3);cursor:pointer;
    font-size:20px;line-height:1;background:rgba(18,28,48,.55);color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.3);
    pointer-events:auto;`
  document.body.appendChild(toggleBtn)

  // Side panel — pin list + actions (only shown while active).
  const panel = document.createElement('div')
  panel.style.cssText = `position:fixed;top:64px;left:12px;z-index:70;width:248px;max-height:70vh;display:none;
    flex-direction:column;font-family:${FONT};color:#eaf2ff;background:rgba(12,20,38,.86);
    border:1px solid rgba(255,255,255,.16);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.45);
    -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);overflow:hidden;pointer-events:auto;`
  const panelHead = document.createElement('div')
  panelHead.style.cssText = `padding:11px 13px;font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;
    border-bottom:1px solid rgba(255,255,255,.12);`
  panelHead.innerHTML = `<span>🌍 Designer</span><span id="sd-ed-count" style="opacity:.6;font-weight:500;font-size:12px"></span>`
  const hint = document.createElement('div')
  hint.style.cssText = `padding:9px 13px;font-size:11.5px;line-height:1.55;color:#bcd0ea;opacity:.92;
    border-bottom:1px solid rgba(255,255,255,.08);`
  hint.innerHTML = '<b>Click</b> the globe to drop a flag<br><b>Drag</b> orbit · <b>Scroll</b> zoom'
  const list = document.createElement('div')
  list.style.cssText = `overflow-y:auto;padding:6px 8px;display:flex;flex-direction:column;gap:5px;flex:1;`
  const actions = document.createElement('div')
  actions.style.cssText = `padding:9px;display:flex;gap:7px;border-top:1px solid rgba(255,255,255,.12);`
  const mkBtn = (label: string, bg: string) => {
    const b = document.createElement('button')
    b.innerHTML = label
    b.style.cssText = `flex:1;padding:8px 6px;border-radius:9px;border:none;cursor:pointer;font-size:12px;
      font-weight:600;color:#0d1426;background:${bg};font-family:${FONT};`
    return b
  }
  const copyBtn = mkBtn('⧉ Copy pins', 'linear-gradient(180deg,#bfe3ff,#7fc6ff)')
  const clearBtn = mkBtn('🗑 Clear', 'rgba(255,255,255,.16)')
  clearBtn.style.color = '#ffd7d0'
  actions.append(copyBtn, clearBtn)
  panel.append(panelHead, hint, list, actions)
  document.body.appendChild(panel)
  const countEl = () => panelHead.querySelector('#sd-ed-count') as HTMLElement

  // ── persistence ─────────────────────────────────────────────────────────────
  function save() {
    const data = pins.map((p) => ({ label: p.label, dir: [p.dir.x, p.dir.y, p.dir.z] }))
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data))
    } catch {
      /* private mode / quota — non-fatal */
    }
  }
  function load() {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(STORE_KEY)
    } catch {
      raw = null
    }
    if (!raw) return
    try {
      const data = JSON.parse(raw) as Array<{ label: string; dir: [number, number, number] }>
      for (const d of data) addPin(new THREE.Vector3(d.dir[0], d.dir[1], d.dir[2]), d.label, false)
    } catch {
      /* corrupt store — ignore */
    }
  }

  // ── pins ──────────────────────────────────────────────────────────────────
  function addPin(dir: THREE.Vector3, label: string, persist = true): EditorPin {
    const d = dir.clone().normalize()
    const g = new THREE.Group()
    g.position.copy(d).multiplyScalar(R)
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d) // post points outward
    g.add(new THREE.Mesh(poleGeo, poleMat), new THREE.Mesh(flagGeo, headMat))
    pinsGroup.add(g)

    const el = document.createElement('div')
    el.style.cssText = `position:absolute;transform:translate(-50%,-120%);white-space:nowrap;font-size:12px;
      font-weight:600;color:#fff;background:rgba(20,30,52,.82);padding:3px 9px;border-radius:999px;
      border:1px solid rgba(255,255,255,.28);box-shadow:0 3px 10px rgba(0,0,0,.4);will-change:transform,left,top;`
    el.textContent = label
    labelLayer.appendChild(el)

    const pin: EditorPin = { id: nextId++, label, dir: d, group: g, el }
    pins.push(pin)
    rebuildList()
    if (persist) save()
    return pin
  }

  function removePin(id: number) {
    const i = pins.findIndex((p) => p.id === id)
    if (i < 0) return
    const p = pins[i]
    pinsGroup.remove(p.group)
    p.el.remove()
    pins.splice(i, 1)
    rebuildList()
    save()
  }

  function clearPins() {
    for (const p of pins.slice()) {
      pinsGroup.remove(p.group)
      p.el.remove()
    }
    pins.length = 0
    rebuildList()
    save()
  }

  function listPins() {
    return pins.map((p) => ({
      label: p.label,
      lat: +latOf(p.dir).toFixed(2),
      lon: +lonOf(p.dir).toFixed(2),
      dir: [+p.dir.x.toFixed(4), +p.dir.y.toFixed(4), +p.dir.z.toFixed(4)] as [number, number, number],
    }))
  }

  function rebuildList() {
    countEl().textContent = pins.length ? `${pins.length} pin${pins.length > 1 ? 's' : ''}` : 'no pins yet'
    list.innerHTML = ''
    pins.forEach((p) => {
      const row = document.createElement('div')
      row.style.cssText = `display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;
        background:rgba(255,255,255,.06);font-size:12px;`
      row.innerHTML =
        `<span style="width:9px;height:9px;border-radius:50%;background:#ff4d3d;flex:none"></span>` +
        `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.label)}</span>` +
        `<span style="opacity:.55;font-size:10.5px">${latOf(p.dir).toFixed(0)}°,${lonOf(p.dir).toFixed(0)}°</span>`
      const del = document.createElement('button')
      del.innerHTML = '✕'
      del.title = 'Delete pin'
      del.style.cssText = `border:none;background:none;color:#ff9a8d;cursor:pointer;font-size:13px;padding:0 2px;flex:none;`
      del.onclick = () => removePin(p.id)
      row.appendChild(del)
      list.appendChild(row)
    })
  }

  // ── raycast pin drop ────────────────────────────────────────────────────────
  // Drop a pin by simply CLICKING the globe (a click, not a drag — drags orbit).
  // Right-click works too. Both go through dropPinAtClient().
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()

  function flashHint(msg: string) {
    const prev = hint.innerHTML
    hint.innerHTML = `<span style="color:#ffd27f">${msg}</span>`
    window.setTimeout(() => (hint.innerHTML = prev), 1500)
  }

  function dropPinAtClient(clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect()
    ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1)
    )
    ray.setFromCamera(ndc, camera)
    const hits = ray.intersectObject(planet.mesh as unknown as THREE.Object3D, true)
    if (!hits.length) {
      flashHint('Click directly on the planet')
      return
    }
    const dir = hits[0].point.clone().normalize()
    const label = window.prompt('Pin label:', `Pin ${pins.length + 1}`)
    if (label == null) return // cancelled
    addPin(dir, label.trim() || `Pin ${pins.length + 1}`)
  }

  // ── label projection (per frame while active) ───────────────────────────────
  const _wp = new THREE.Vector3()
  const _camDir = new THREE.Vector3()
  function projectLabels() {
    const w = window.innerWidth
    const h = window.innerHeight
    _camDir.copy(camera.position).normalize()
    const horizon = R / Math.max(camera.position.length(), R + 1e-3) // front-hemisphere cutoff
    for (const p of pins) {
      // hide pins on the far side of the globe
      if (p.dir.dot(_camDir) < horizon) {
        p.el.style.display = 'none'
        continue
      }
      _wp.copy(p.dir).multiplyScalar(R + PIN_TOP)
      _wp.project(camera)
      if (_wp.z > 1) {
        p.el.style.display = 'none'
        continue
      }
      p.el.style.display = ''
      p.el.style.left = `${(_wp.x * 0.5 + 0.5) * w}px`
      p.el.style.top = `${(-_wp.y * 0.5 + 0.5) * h}px`
    }
  }

  // ── open / close ────────────────────────────────────────────────────────────
  function ensureControls(): OrbitControls {
    if (controls) return controls
    controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.rotateSpeed = 0.5
    controls.zoomSpeed = 0.9
    controls.enablePan = false
    controls.minDistance = R * 1.04
    controls.maxDistance = R * 5
    // free the right mouse button for pin-dropping (left orbits, wheel zooms)
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: -1 as unknown as THREE.MOUSE,
    }
    controls.target.set(0, 0, 0)
    controls.enabled = false
    return controls
  }

  function open() {
    if (active) return
    active = true
    const c = ensureControls()
    flow.setChromeVisible(false)
    hudRoot.style.visibility = 'hidden'
    panel.style.display = 'flex'
    toggleBtn.style.background = 'linear-gradient(180deg,#ffd27f,#ff9a3c)'
    // frame the whole globe at a pleasant angle
    camera.up.set(0, 1, 0)
    camera.position.set(R * 1.4, R * 1.1, R * 1.9)
    c.target.set(0, 0, 0)
    c.enabled = true
    c.update()
    projectLabels()
  }

  function close() {
    if (!active) return
    active = false
    if (controls) controls.enabled = false
    flow.setChromeVisible(true)
    panel.style.display = 'none'
    toggleBtn.style.background = 'rgba(18,28,48,.55)'
    for (const p of pins) p.el.style.display = 'none' // hidden until reopened
  }

  function toggle() {
    active ? close() : open()
  }

  function update(_dt: number) {
    if (!active) return
    controls?.update()
    projectLabels()
  }

  // ── wiring ──────────────────────────────────────────────────────────────────
  toggleBtn.onclick = toggle
  copyBtn.onclick = async () => {
    const json = JSON.stringify(listPins(), null, 2)
    try {
      await navigator.clipboard.writeText(json)
      copyBtn.innerHTML = '✓ Copied'
      window.setTimeout(() => (copyBtn.innerHTML = '⧉ Copy pins'), 1400)
    } catch {
      window.prompt('Copy pin JSON:', json)
    }
  }
  clearBtn.onclick = () => {
    if (pins.length && window.confirm(`Delete all ${pins.length} pins?`)) clearPins()
  }
  // Right-click the globe → instant pin (capture phase so nothing swallows it).
  window.addEventListener(
    'contextmenu',
    (e) => {
      if (!active || e.target !== canvas) return
      e.preventDefault()
      dropPinAtClient(e.clientX, e.clientY)
    },
    true
  )
  // Plain LEFT-CLICK on the globe → drop a pin. We watch on the window in capture
  // phase (so OrbitControls can't swallow it) and tell a click from an orbit-drag
  // by total pointer travel + duration. A drag orbits; a tap drops a flag.
  let downX = 0
  let downY = 0
  let downT = 0
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!active || e.button !== 0 || e.target !== canvas) return
      downX = e.clientX
      downY = e.clientY
      downT = e.timeStamp
    },
    true
  )
  window.addEventListener(
    'pointerup',
    (e) => {
      if (!active || e.button !== 0 || e.target !== canvas) return
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY)
      if (moved < 6 && e.timeStamp - downT < 400) dropPinAtClient(e.clientX, e.clientY)
    },
    true
  )
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyE' && !e.metaKey && !e.ctrlKey && !e.altKey) toggle()
  })

  load() // restore saved pins (kept hidden until the editor opens)
  for (const p of pins) p.el.style.display = 'none'

  const api: Editor = {
    isActive: () => active,
    toggle,
    open,
    close,
    update,
    addPin: (dir, label) => addPin(dir, label),
    listPins,
    clearPins,
  }
  ;(window as unknown as { __sdEditor: Editor }).__sdEditor = api
  return api
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

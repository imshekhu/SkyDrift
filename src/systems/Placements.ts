import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { WORLD_SCALE } from '../world/WorldConfig'
import { FLAT_CORE_GAP } from '../world/Planet'
import { SITES, LAND_HEIGHT } from '../world/Sites'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Designer Placements
//
// (A) The four hand-pinned hero structures from the Designer editor, each seated
//     on the CORE shell (radius − FLAT_CORE_GAP) and oriented to the local normal
//     (+Y = outward). All have been SHRUNK so their tallest point is < 45 units
//     above their base — the plane cruises at radius+64, the core sits 6 below the
//     crust, so a building taller than ~45 would clip the flight band.
//
//       • lighthouse — banded tower, lantern room + rotating light beam
//       • creek      — a meandering, rippling translucent water ribbon + sandy banks
//       • tower      — modern glass skyscraper with lit windows + antenna
//       • decoCity   — a 1920s Art-Deco downtown: setback towers, stepped crowns
//
// (B) SITES-driven content filling the planet. The Landscape system builds a
//     landmass at each SITES[i].dir (seated on the crust, radius 640). We rest our
//     structures on those landmasses: R_surface = planet.radius, base +1.5 so it
//     sits ON the land.
//       • hasTown sites  → a SETTLEMENT: ~6–12 cottages, a couple of shops, an
//                          animated windmill, and a church/clock tower.
//       • other sites    → ONE landmark, rotating through: coastal lighthouse,
//                          stone obelisk, lone windmill, giant tree, small fort.
//
// HARD RULE everywhere: nothing taller than 45 units above its base.
// ─────────────────────────────────────────────────────────────────────────────

const S = WORLD_SCALE
const UP_Y = new THREE.Vector3(0, 1, 0)
const col = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)
const mat = (hex: number, opts: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color: col(hex), flatShading: true, roughness: 0.85, metalness: 0, ...opts })
const glow = (hex: number) => new THREE.MeshBasicMaterial({ color: col(hex), toneMapped: false })
const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => new THREE.Mesh(g, m)

// shared accent palette (sRGB) — warm cozy village tones
const VCOL = {
  wallA: 0xead9b8,
  wallB: 0xe7c79a,
  wallC: 0xd9b483,
  wallShop: 0xcf9f78,
  roofRed: 0xc7625a,
  roofTeal: 0x6fb3a8,
  roofBlue: 0x6b86c0,
  roofBrown: 0x9c6f4e,
  wood: 0x8a6243,
  woodDark: 0x6f4f3a,
  stone: 0xcfc6b2,
  stoneDark: 0xb4a98f,
  sail: 0xf3ede0,
  door: 0x5c4636,
  glassWin: 0xffe9a8,
  trunk: 0x8a6243,
  leafA: 0x3f8f55,
  leafB: 0x57a86b,
} as const

type Kind = 'lighthouse' | 'creek' | 'tower' | 'decoCity'
interface Built {
  group: THREE.Group
  animate?: (t: number, dt: number) => void
}

// The four pins exported from the Designer editor.
const PLACEMENTS: Array<{ dir: [number, number, number]; kind: Kind; label: string }> = [
  { dir: [-0.6409, 0.736, 0.2181], kind: 'lighthouse', label: 'Lighthouse' },
  { dir: [-0.152, 0.9875, 0.043], kind: 'creek', label: 'Water Creek' },
  { dir: [0.1824, 0.9328, -0.3107], kind: 'tower', label: 'Tall Tower' },
  { dir: [0.3207, 0.9275, 0.1921], kind: 'decoCity', label: '1920s City' },
]

// ── lighthouse (SHRUNK: top ≈ 44u) ─────────────────────────────────────────────
function buildLighthouse(): Built {
  const g = new THREE.Group()
  const gray = mat(0x9a8f86)
  const white = mat(0xf4f0f7)
  const red = mat(0xd64a3f)
  const dark = mat(0x3a3a44)

  // authored heights kept small; total tower band height ≈ 3.4S → top ≈ 44u (< 45)
  const base = mesh(new THREE.CylinderGeometry(1.6 * S, 2.3 * S, 0.7 * S, 14), gray)
  base.position.y = 0.35 * S
  g.add(base)

  let y = 0.7 * S
  const bands = 5
  const bandH = 0.62 * S
  for (let i = 0; i < bands; i++) {
    const rB = THREE.MathUtils.lerp(1.2, 0.78, i / bands) * S
    const rT = THREE.MathUtils.lerp(1.2, 0.78, (i + 1) / bands) * S
    const seg = mesh(new THREE.CylinderGeometry(rT, rB, bandH, 14), i % 2 ? red : white)
    seg.position.y = y + bandH / 2
    g.add(seg)
    y += bandH
  }

  const gallery = mesh(new THREE.CylinderGeometry(1.02 * S, 1.02 * S, 0.22 * S, 14), dark)
  gallery.position.y = y + 0.11 * S
  g.add(gallery)
  y += 0.22 * S

  const lantern = mesh(
    new THREE.CylinderGeometry(0.74 * S, 0.74 * S, 0.7 * S, 10),
    new THREE.MeshStandardMaterial({ color: col(0x9fe8ff), transparent: true, opacity: 0.4, roughness: 0.1, flatShading: true })
  )
  const lightY = y + 0.35 * S
  lantern.position.y = lightY
  g.add(lantern)

  const core = mesh(new THREE.SphereGeometry(0.34 * S, 12, 8), glow(0xffe6a0))
  core.position.y = lightY
  g.add(core)

  const roof = mesh(new THREE.ConeGeometry(0.86 * S, 0.6 * S, 12), red)
  roof.position.y = y + 0.7 * S + 0.3 * S
  g.add(roof)

  // rotating sweep beam: a hollow cone widening outward from the lamp
  const beamPivot = new THREE.Group()
  beamPivot.position.y = lightY
  g.add(beamPivot)
  const beamLen = 11 * S
  const beamGeo = new THREE.ConeGeometry(1.2 * S, beamLen, 14, 1, true)
  beamGeo.rotateZ(Math.PI / 2) // apex → -X, base → +X
  beamGeo.translate(beamLen / 2, 0, 0) // apex at the lamp, base out at +X
  const beam = new THREE.Mesh(
    beamGeo,
    new THREE.MeshBasicMaterial({
      color: col(0xfff1b0),
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    })
  )
  beamPivot.add(beam)

  return { group: g, animate: (_t, dt) => (beamPivot.rotation.y += dt * 0.8) }
}

// ── creek (water) — already low (top ≈ 3u); kept as-is ──────────────────────────
function buildCreek(): Built {
  const g = new THREE.Group()
  const L = 20 * S
  const N = 40
  const center = (t: number) => ({
    x: (t - 0.5) * L,
    z: Math.sin(t * Math.PI * 2.4) * 2.6 * S + Math.sin(t * Math.PI * 5.0) * 0.7 * S,
  })

  function strip(width: number, yOff: number, material: THREE.Material) {
    const pos: number[] = []
    const idx: number[] = []
    for (let i = 0; i <= N; i++) {
      const t = i / N
      const c = center(t)
      const c2 = center(Math.min(1, t + 0.001))
      let tx = c2.x - c.x
      let tz = c2.z - c.z
      const len = Math.hypot(tx, tz) || 1
      tx /= len
      tz /= len
      const nx = -tz
      const nz = tx
      const w = width * (0.55 + 0.45 * Math.sin(t * Math.PI)) // taper at the ends
      pos.push(c.x + nx * w, yOff, c.z + nz * w)
      pos.push(c.x - nx * w, yOff, c.z - nz * w)
      if (i < N) {
        const a = i * 2
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setIndex(idx)
    geo.computeVertexNormals()
    return { mesh: new THREE.Mesh(geo, material), geo }
  }

  const bank = strip(3.2 * S, 0.14 * S, mat(0xe2cf9e, { roughness: 1, side: THREE.DoubleSide }))
  const water = strip(
    2.0 * S,
    0.36 * S,
    new THREE.MeshStandardMaterial({
      color: col(0x46a6e0),
      transparent: true,
      opacity: 0.9,
      roughness: 0.22,
      metalness: 0,
      flatShading: true,
      side: THREE.DoubleSide,
    })
  )
  g.add(bank.mesh, water.mesh)

  const wPos = water.geo.attributes.position as THREE.BufferAttribute
  const base = new Float32Array(wPos.array.length)
  base.set(wPos.array as Float32Array)
  const animate = (t: number) => {
    const arr = wPos.array as Float32Array
    for (let i = 0; i < arr.length; i += 3) {
      arr[i + 1] = base[i + 1] + Math.sin(base[i] * 0.6 + t * 2.2) * 0.11 * S
    }
    wPos.needsUpdate = true
  }
  return { group: g, animate }
}

// ── modern skyscraper ────────────────────────────────────────────────────────
function makeWindowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 128
  const x = c.getContext('2d')!
  x.fillStyle = '#1c2a3a'
  x.fillRect(0, 0, 64, 128)
  const cols = 6
  const rows = 16
  const m = 3
  const cw = (64 - (cols + 1) * m) / cols
  const ch = (128 - (rows + 1) * m) / rows
  for (let r = 0; r < rows; r++) {
    for (let ci = 0; ci < cols; ci++) {
      x.fillStyle = Math.random() < 0.4 ? '#ffe9a8' : '#33485f'
      x.fillRect(m + ci * (cw + m), m + r * (ch + m), cw, ch)
    }
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(2, 3)
  return t
}

// SHRUNK: tiers 3.2+2.4+1.6 = 7.2S, + pad 0.3S + antenna 1.0S ≈ tip 44u (< 45)
function buildTower(): Built {
  const g = new THREE.Group()
  const winTex = makeWindowTexture()
  const glass = new THREE.MeshStandardMaterial({
    map: winTex,
    emissiveMap: winTex,
    emissive: new THREE.Color(0x2a2a12),
    emissiveIntensity: 0.9,
    color: col(0x8fb6d8),
    roughness: 0.35,
    metalness: 0.15,
  })

  const pad = mesh(new THREE.CylinderGeometry(3.4 * S, 3.4 * S, 0.3 * S, 16), mat(0x9aa0a8))
  pad.position.y = 0.15 * S
  g.add(pad)

  const tiers = [
    { w: 2.6, h: 3.2 },
    { w: 1.95, h: 2.4 },
    { w: 1.35, h: 1.6 },
  ]
  let y = 0.3 * S
  for (const t of tiers) {
    const b = mesh(new THREE.BoxGeometry(t.w * S, t.h * S, t.w * S), glass)
    b.position.y = y + (t.h * S) / 2
    g.add(b)
    y += t.h * S
  }
  const ant = mesh(new THREE.CylinderGeometry(0.06 * S, 0.06 * S, 1.0 * S, 6), mat(0x44474f))
  ant.position.y = y + 0.5 * S
  g.add(ant)
  const tip = mesh(new THREE.SphereGeometry(0.18 * S, 8, 6), glow(0xff4d3d))
  tip.position.y = y + 1.0 * S
  g.add(tip)
  return { group: g }
}

// ── 1920s Art-Deco city ──────────────────────────────────────────────────────
function buildDecoTower(w: number, h: number, bodyHex: number, trimHex: number, withSpire = true): THREE.Group {
  const g = new THREE.Group()
  const body = mat(bodyHex)
  const trim = mat(trimHex)
  const tiers = [
    { wf: 1.0, hf: 0.5 },
    { wf: 0.72, hf: 0.3 },
    { wf: 0.5, hf: 0.2 },
  ]
  let y = 0
  for (const ti of tiers) {
    const tw = w * ti.wf
    const th = h * ti.hf
    const b = mesh(new THREE.BoxGeometry(tw, th, tw), body)
    b.position.y = y + th / 2
    g.add(b)
    // deco verticality: slim trim pilasters up the corners of the main tier
    if (ti.wf === 1.0) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const pil = mesh(new THREE.BoxGeometry(tw * 0.1, th, tw * 0.1), trim)
          pil.position.set(sx * tw * 0.46, y + th / 2, sz * tw * 0.46)
          g.add(pil)
        }
      }
    }
    const cornice = mesh(new THREE.BoxGeometry(tw * 1.08, th * 0.06, tw * 1.08), trim)
    cornice.position.y = y + th
    g.add(cornice)
    y += th
  }
  // stepped deco crown
  let cw = w * 0.5
  for (let k = 0; k < 3; k++) {
    const chh = h * 0.05
    const c = mesh(new THREE.BoxGeometry(cw, chh, cw), trim)
    c.position.y = y + chh / 2
    g.add(c)
    y += chh
    cw *= 0.72
  }
  if (withSpire) {
    const spireH = h * 0.22
    const spire = mesh(new THREE.ConeGeometry(cw * 0.62, spireH, 4), trim)
    spire.position.y = y + spireH / 2
    g.add(spire)
    y += spireH
    const tip = mesh(new THREE.SphereGeometry(w * 0.07, 8, 6), glow(0xffd24a))
    tip.position.y = y
    g.add(tip)
  }
  return g
}

// SHRUNK: hero h ≈ 5.6S → crown/spire total ≈ 43u (< 45); plaza low.
function buildDecoCity(): Built {
  const g = new THREE.Group()
  const plaza = mesh(new THREE.CylinderGeometry(13 * S, 13.4 * S, 0.5 * S, 12), mat(0xcdbb95))
  plaza.position.y = 0.25 * S
  g.add(plaza)
  // a darker plaza inlay so the ground reads as paved streets, not bare sand
  const inlay = mesh(new THREE.CylinderGeometry(12.2 * S, 12.2 * S, 0.52 * S, 12), mat(0xb6a37e))
  inlay.position.y = 0.255 * S
  inlay.scale.y = 1.001
  g.add(inlay)

  const bodies = [0xe6d8b8, 0xd8c39a, 0xcaa779, 0xd9b48a, 0xe0c8a0]
  const trim = 0xb9966a
  const place = (x: number, z: number, h: number, w: number, spire: boolean) => {
    const t = buildDecoTower(w, h, bodies[(Math.random() * bodies.length) | 0], trim, spire)
    t.position.set(x, 0.5 * S, z)
    t.rotation.y = Math.random() * Math.PI
    g.add(t)
  }

  // inner ring: 6 spired skyscrapers around a central plaza
  const innerN = 6
  const innerR = 4.2 * S
  for (let i = 0; i < innerN; i++) {
    const a = (i / innerN) * Math.PI * 2 + 0.3
    const jr = (Math.random() - 0.5) * 1.2 * S
    place(
      Math.cos(a) * (innerR + jr),
      Math.sin(a) * (innerR + jr),
      (3.6 + Math.random() * 1.0) * S,
      (1.6 + Math.random() * 0.5) * S,
      true
    )
  }
  // a hero tower dead centre — tallest in the city, ≈ 43u above its 0.5S base
  place(0, 0, (5.4 + Math.random() * 0.4) * S, 2.1 * S, true)

  // outer ring: 10 shorter deco blocks (mixed spired / flat-crown)
  const outerN = 10
  const outerR = 9 * S
  for (let i = 0; i < outerN; i++) {
    const a = (i / outerN) * Math.PI * 2 + 0.15
    const jr = (Math.random() - 0.5) * 2.0 * S
    place(
      Math.cos(a) * (outerR + jr),
      Math.sin(a) * (outerR + jr),
      (2.4 + Math.random() * 1.4) * S,
      (1.7 + Math.random() * 0.7) * S,
      Math.random() < 0.45
    )
  }
  return { group: g }
}

// ─────────────────────────────────────────────────────────────────────────────
// (B) SITES content — small low-poly builders. All heights authored in WORLD
// units already (NOT ×S): a cottage ~6–12, windmill ~26, church tower ~32, all
// well under the 45-unit ceiling. Builders take a per-call rand:()=>number so
// each site varies deterministically.
// ─────────────────────────────────────────────────────────────────────────────

type Rand = () => number
// spinner / ripple animation registries are filled at build time, played in update
interface SpinTarget {
  obj: THREE.Object3D
  axis: 'x' | 'y' | 'z'
  speed: number
}

// a single cottage: walls + a gable OR hip roof + door, varied warm wall color
function buildCottage(rand: Rand): THREE.Group {
  const g = new THREE.Group()
  const wallHex = [VCOL.wallA, VCOL.wallB, VCOL.wallC][(rand() * 3) | 0]
  const roofHex = [VCOL.roofRed, VCOL.roofTeal, VCOL.roofBlue, VCOL.roofBrown][(rand() * 4) | 0]
  const w = 5 + rand() * 3 // 5..8
  const d = 4.5 + rand() * 2.5
  const wallH = 4 + rand() * 3 // 4..7
  const walls = mesh(new THREE.BoxGeometry(w, wallH, d), mat(wallHex))
  walls.position.y = wallH / 2
  g.add(walls)

  const roofH = 2.5 + rand() * 1.8
  if (rand() < 0.5) {
    // gable roof: a triangular prism (cone, 4-sided, scaled) along X
    const roof = mesh(new THREE.CylinderGeometry(0.001, w * 0.78, roofH, 4), mat(roofHex))
    // a 3-sided "tent" reads better as a gable: use a box-prism via Cone w/ 3? keep simple:
    roof.scale.z = (d * 1.05) / (w * 0.78 * 1.6)
    roof.rotation.y = Math.PI / 4
    roof.position.y = wallH + roofH / 2
    g.add(roof)
  } else {
    // hip roof: a low 4-sided pyramid
    const roof = mesh(new THREE.ConeGeometry(w * 0.82, roofH, 4), mat(roofHex))
    roof.rotation.y = Math.PI / 4
    roof.position.y = wallH + roofH / 2
    g.add(roof)
  }

  const door = mesh(new THREE.BoxGeometry(1.1, 2.0, 0.3), mat(VCOL.door))
  door.position.set(0, 1.0, d / 2 + 0.05)
  g.add(door)
  // a tiny warm window
  const win = mesh(new THREE.BoxGeometry(0.9, 0.9, 0.2), glow(0xffe9a8))
  win.position.set(w * 0.28, wallH * 0.6, d / 2 + 0.05)
  g.add(win)
  return g
}

// a shop: a wider cottage with an awning stripe and a flat-ish sign
function buildShop(rand: Rand): THREE.Group {
  const g = new THREE.Group()
  const w = 7 + rand() * 2
  const d = 5.5 + rand() * 1.5
  const wallH = 5.5 + rand() * 2
  const walls = mesh(new THREE.BoxGeometry(w, wallH, d), mat(VCOL.wallShop))
  walls.position.y = wallH / 2
  g.add(walls)
  // flat parapet roof
  const roof = mesh(new THREE.BoxGeometry(w * 1.04, 0.8, d * 1.04), mat(VCOL.roofBrown))
  roof.position.y = wallH + 0.4
  g.add(roof)
  // striped awning over the front
  const awning = mesh(new THREE.BoxGeometry(w * 0.9, 0.4, 2.0), mat(VCOL.roofRed))
  awning.position.set(0, wallH * 0.62, d / 2 + 0.9)
  awning.rotation.x = -0.32
  g.add(awning)
  // a sign board
  const sign = mesh(new THREE.BoxGeometry(w * 0.6, 1.2, 0.3), mat(VCOL.wood))
  sign.position.set(0, wallH * 0.85, d / 2 + 0.2)
  g.add(sign)
  // shop window glow
  const win = mesh(new THREE.BoxGeometry(w * 0.5, 1.6, 0.2), glow(0xffe9a8))
  win.position.set(0, wallH * 0.4, d / 2 + 0.05)
  g.add(win)
  return g
}

// a windmill with animated blades. Total height ≈ 26u (tower 18 + cap 2 + blade span).
function buildWindmill(rand: Rand, spinners: SpinTarget[]): THREE.Group {
  const g = new THREE.Group()
  const towerH = 16 + rand() * 3 // 16..19
  const tower = mesh(new THREE.CylinderGeometry(2.4, 3.4, towerH, 10), mat(VCOL.stone))
  tower.position.y = towerH / 2
  g.add(tower)
  // balcony gallery
  const balcony = mesh(new THREE.TorusGeometry(2.7, 0.22, 5, 14), mat(VCOL.wood))
  balcony.position.y = towerH * 0.82
  balcony.rotation.x = Math.PI / 2
  g.add(balcony)
  // conical cap
  const capH = 2.8
  const cap = mesh(new THREE.ConeGeometry(2.9, capH, 10), mat(VCOL.roofTeal))
  cap.position.y = towerH + capH / 2
  g.add(cap)
  // door
  const door = mesh(new THREE.BoxGeometry(1.2, 2.1, 0.4), mat(VCOL.door))
  door.position.set(0, 1.05, 3.0)
  g.add(door)

  // rotor on the +Z face; blades spin about local +Z
  const rotor = new THREE.Group()
  rotor.position.set(0, towerH + 0.4, 3.0)
  g.add(rotor)
  const hub = mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.0, 8), mat(VCOL.woodDark))
  hub.rotation.x = Math.PI / 2
  rotor.add(hub)
  const bladeLen = 7.0
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Group()
    const arm = mesh(new THREE.BoxGeometry(0.45, bladeLen, 0.35), mat(VCOL.wood))
    arm.position.y = bladeLen / 2
    const sail = mesh(new THREE.BoxGeometry(2.0, bladeLen * 0.62, 0.14), mat(VCOL.sail))
    sail.position.set(1.0, bladeLen * 0.5, 0.1)
    blade.add(arm, sail)
    blade.rotation.z = (i / 4) * Math.PI * 2
    rotor.add(blade)
  }
  spinners.push({ obj: rotor, axis: 'z', speed: 0.8 + rand() * 0.5 })
  return g
}

// church / clock tower: a nave + a tall steeple. Total ≈ 30–32u (< 45).
function buildChurch(rand: Rand): THREE.Group {
  const g = new THREE.Group()
  const naveW = 6
  const naveD = 10
  const naveH = 7
  const nave = mesh(new THREE.BoxGeometry(naveW, naveH, naveD), mat(VCOL.wallA))
  nave.position.y = naveH / 2
  g.add(nave)
  // pitched nave roof
  const naveRoof = mesh(new THREE.CylinderGeometry(0.001, naveW * 0.8, 2.6, 4), mat(VCOL.roofRed))
  naveRoof.scale.z = (naveD * 1.05) / (naveW * 0.8 * 1.6)
  naveRoof.rotation.y = Math.PI / 4
  naveRoof.position.y = naveH + 1.3
  g.add(naveRoof)

  // bell/clock tower at the front
  const towerW = 4
  const towerH = 22 + rand() * 4 // 22..26
  const tower = mesh(new THREE.BoxGeometry(towerW, towerH, towerW), mat(VCOL.stone))
  tower.position.set(0, towerH / 2, naveD / 2 - 0.5)
  g.add(tower)
  // clock face (glowing)
  const clock = mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.25, 12), glow(0xfff0c8))
  clock.rotation.x = Math.PI / 2
  clock.position.set(0, towerH * 0.78, naveD / 2 - 0.5 + towerW / 2 + 0.05)
  g.add(clock)
  // belfry openings (dark)
  const belfry = mesh(new THREE.BoxGeometry(towerW * 1.02, 2.2, towerW * 1.02), mat(VCOL.woodDark))
  belfry.position.set(0, towerH * 0.92, naveD / 2 - 0.5)
  g.add(belfry)
  // steeple spire — keep total tower+spire ≤ ~32
  const spireH = 6
  const spire = mesh(new THREE.ConeGeometry(towerW * 0.7, spireH, 4), mat(VCOL.roofBlue))
  spire.rotation.y = Math.PI / 4
  spire.position.set(0, towerH + spireH / 2, naveD / 2 - 0.5)
  g.add(spire)
  const cross = mesh(new THREE.SphereGeometry(0.4, 8, 6), glow(0xffd24a))
  cross.position.set(0, towerH + spireH + 0.4, naveD / 2 - 0.5)
  g.add(cross)
  return g
}

// ── single-landmark builders (for non-town sites) ─────────────────────────────

// short coastal lighthouse (top ≈ 22u)
function buildCoastalLighthouse(rand: Rand): THREE.Group {
  const g = new THREE.Group()
  const towerH = 14 + rand() * 3
  let y = 0
  const bands = 5
  const bandH = towerH / bands
  for (let i = 0; i < bands; i++) {
    const rB = THREE.MathUtils.lerp(2.4, 1.5, i / bands)
    const rT = THREE.MathUtils.lerp(2.4, 1.5, (i + 1) / bands)
    const seg = mesh(new THREE.CylinderGeometry(rT, rB, bandH, 12), i % 2 ? mat(0xd64a3f) : mat(0xf4f0f7))
    seg.position.y = y + bandH / 2
    g.add(seg)
    y += bandH
  }
  const gallery = mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.6, 12), mat(0x3a3a44))
  gallery.position.y = y + 0.3
  g.add(gallery)
  y += 0.6
  const lamp = mesh(new THREE.SphereGeometry(1.0, 12, 8), glow(0xffe6a0))
  lamp.position.y = y + 0.9
  g.add(lamp)
  const roof = mesh(new THREE.ConeGeometry(1.6, 1.8, 12), mat(0xd64a3f))
  roof.position.y = y + 2.4
  g.add(roof)
  return g
}

// stone monument / obelisk (top ≈ 26u)
function buildObelisk(rand: Rand): THREE.Group {
  const g = new THREE.Group()
  const base0 = mesh(new THREE.BoxGeometry(6, 1.6, 6), mat(VCOL.stoneDark))
  base0.position.y = 0.8
  const base1 = mesh(new THREE.BoxGeometry(4.4, 1.4, 4.4), mat(VCOL.stone))
  base1.position.y = 2.3
  g.add(base0, base1)
  const shaftH = 18 + rand() * 4
  const shaft = mesh(new THREE.CylinderGeometry(1.0, 1.9, shaftH, 4), mat(VCOL.stone))
  shaft.rotation.y = Math.PI / 4
  shaft.position.y = 3 + shaftH / 2
  g.add(shaft)
  const cap = mesh(new THREE.ConeGeometry(1.3, 2.4, 4), mat(0xb9966a))
  cap.rotation.y = Math.PI / 4
  cap.position.y = 3 + shaftH + 1.2
  g.add(cap)
  return g
}

// giant tree (top ≈ 28u)
function buildGiantTree(rand: Rand): THREE.Group {
  const g = new THREE.Group()
  const trunkH = 11 + rand() * 3
  const trunk = mesh(new THREE.CylinderGeometry(1.3, 2.1, trunkH, 7), mat(VCOL.trunk))
  trunk.position.y = trunkH / 2
  g.add(trunk)
  const blobs: Array<[number, number, number, number, number]> = [
    [4.4, 0, trunkH + 1.0, 0, VCOL.leafA],
    [3.2, 3.2, trunkH - 0.4, 1.0, VCOL.leafB],
    [3.2, -3.0, trunkH - 0.2, -1.2, VCOL.leafA],
    [3.0, 0.6, trunkH - 0.6, 3.0, VCOL.leafB],
    [2.4, 2.4, trunkH + 2.6, -1.8, VCOL.leafA],
  ]
  for (const [r, x, yy, z, hex] of blobs) {
    const b = mesh(new THREE.IcosahedronGeometry(r, 0), mat(hex))
    b.position.set(x, yy, z)
    g.add(b)
  }
  return g
}

// lone windmill (reuses the town windmill builder)
function buildLoneWindmill(rand: Rand, spinners: SpinTarget[]): THREE.Group {
  return buildWindmill(rand, spinners)
}

// small fort: a square keep with corner turrets + crenellations (top ≈ 18u)
function buildFort(rand: Rand): THREE.Group {
  const g = new THREE.Group()
  const wallH = 7 + rand() * 1.5
  const span = 11
  // four curtain walls as a hollow square (use a solid block keep for simplicity + low poly)
  const keep = mesh(new THREE.BoxGeometry(span, wallH, span), mat(VCOL.stone))
  keep.position.y = wallH / 2
  g.add(keep)
  // crenellation ring (thin merlons around the top edge)
  const merlonGeo = new THREE.BoxGeometry(1.2, 1.4, 1.2)
  const merlonMat = mat(VCOL.stoneDark)
  const per = 4
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < per; i++) {
      const t = (i + 0.5) / per - 0.5
      const m = new THREE.Mesh(merlonGeo, merlonMat)
      const along = t * span
      if (s === 0) m.position.set(along, wallH + 0.7, span / 2)
      else if (s === 1) m.position.set(along, wallH + 0.7, -span / 2)
      else if (s === 2) m.position.set(span / 2, wallH + 0.7, along)
      else m.position.set(-span / 2, wallH + 0.7, along)
      g.add(m)
    }
  }
  // corner turrets, a touch taller
  const turretH = wallH + 4
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const turret = mesh(new THREE.CylinderGeometry(1.8, 2.0, turretH, 8), mat(VCOL.stoneDark))
      turret.position.set((sx * span) / 2, turretH / 2, (sz * span) / 2)
      g.add(turret)
      const roof = mesh(new THREE.ConeGeometry(2.1, 2.6, 8), mat(VCOL.roofRed))
      roof.position.set((sx * span) / 2, turretH + 1.3, (sz * span) / 2)
      g.add(roof)
    }
  }
  // gate
  const gate = mesh(new THREE.BoxGeometry(2.4, 3.4, 0.5), mat(VCOL.woodDark))
  gate.position.set(0, 1.7, span / 2 + 0.05)
  g.add(gate)
  return g
}

// ── system ───────────────────────────────────────────────────────────────────
export function createPlacementsSystem(): GameSystem {
  const root = new THREE.Group()
  root.name = 'placements'
  const animers: Array<(t: number, dt: number) => void> = []
  const spinners: SpinTarget[] = []
  let elapsed = 0

  return {
    name: 'placements',
    init(ctx: GameContext) {
      // ── (A) hero pins → anchored to the CORE shell (below the crust) ──────────
      const Rcore = ctx.planet.radius - FLAT_CORE_GAP
      for (const p of PLACEMENTS) {
        const built: Built =
          p.kind === 'lighthouse'
            ? buildLighthouse()
            : p.kind === 'creek'
              ? buildCreek()
              : p.kind === 'tower'
                ? buildTower()
                : buildDecoCity()
        const up = new THREE.Vector3(p.dir[0], p.dir[1], p.dir[2]).normalize()
        built.group.position.copy(up).multiplyScalar(Rcore)
        built.group.quaternion.setFromUnitVectors(UP_Y, up)
        built.group.name = `placement.${p.label}`
        root.add(built.group)
        if (built.animate) animers.push(built.animate)
      }

      // ── (B) SITES → settlements on town sites, one landmark elsewhere ─────────
      // Seat on the island HILLTOP: the core shell (radius − FLAT_CORE_GAP) plus the
      // landmass dome height, so towns/landmarks sit on the curved green hill that
      // Landscape raises above the blue crust at each site. +1.5 rests the base ON it.
      const Rsurface = ctx.planet.radius - FLAT_CORE_GAP + LAND_HEIGHT
      const SEAT = 1.5
      let landmarkRot = 0 // rotate through the 5 landmark types
      const landmarkBuilders: Array<(rand: Rand) => THREE.Group> = [
        (r) => buildCoastalLighthouse(r),
        (r) => buildObelisk(r),
        (r) => buildLoneWindmill(r, spinners),
        (r) => buildGiantTree(r),
        (r) => buildFort(r),
      ]

      for (let si = 0; si < SITES.length; si++) {
        const site = SITES[si]
        const up = new THREE.Vector3(site.dir[0], site.dir[1], site.dir[2]).normalize()
        // one parent group per site, oriented to the local normal (+Y = outward).
        // Sub-structures are offset in the local tangent plane (local X/Z); fine
        // for small town footprints relative to the 640-radius globe.
        const siteGroup = new THREE.Group()
        siteGroup.position.copy(up).multiplyScalar(Rsurface + SEAT)
        siteGroup.quaternion.setFromUnitVectors(UP_Y, up)
        siteGroup.scale.setScalar(1.066) // toned-down size, then +30%
        siteGroup.name = `site.${site.name}`
        root.add(siteGroup)

        // keep footprints well inside the landmass radius
        const fit = site.radius * 0.6

        if (site.hasTown) {
          // settlement: cottages ring + a few shops + a windmill + a church
          const nCottage = 6 + ((ctx.rand() * 7) | 0) // 6..12
          const ringR = Math.min(fit * 0.72, 26 * S * 0.35 + 8)
          for (let i = 0; i < nCottage; i++) {
            const a = (i / nCottage) * Math.PI * 2 + ctx.rand() * 0.5
            const rr = ringR * (0.5 + ctx.rand() * 0.5)
            const cottage = buildCottage(ctx.rand)
            cottage.position.set(Math.cos(a) * rr, 0, Math.sin(a) * rr)
            cottage.rotation.y = ctx.rand() * Math.PI * 2
            siteGroup.add(cottage)
          }
          // a couple of shops nearer the centre
          for (let i = 0; i < 2; i++) {
            const a = ctx.rand() * Math.PI * 2
            const rr = ringR * 0.35
            const shop = buildShop(ctx.rand)
            shop.position.set(Math.cos(a) * rr, 0, Math.sin(a) * rr)
            shop.rotation.y = ctx.rand() * Math.PI * 2
            siteGroup.add(shop)
          }
          // a windmill out toward the edge of the town
          {
            const a = ctx.rand() * Math.PI * 2
            const rr = Math.min(fit * 0.85, ringR * 1.3)
            const wm = buildWindmill(ctx.rand, spinners)
            wm.position.set(Math.cos(a) * rr, 0, Math.sin(a) * rr)
            wm.rotation.y = ctx.rand() * Math.PI * 2
            siteGroup.add(wm)
          }
          // a church/clock tower marking the town centre
          {
            const church = buildChurch(ctx.rand)
            church.position.set(0, 0, 0)
            church.rotation.y = ctx.rand() * Math.PI * 2
            siteGroup.add(church)
          }
        } else {
          // a single landmark, cycling through the five types
          const build = landmarkBuilders[landmarkRot % landmarkBuilders.length]
          landmarkRot++
          const node = build(ctx.rand)
          node.rotation.y = ctx.rand() * Math.PI * 2
          siteGroup.add(node)
        }
      }

      ctx.scene.add(root)
    },
    update(dt: number) {
      elapsed += dt
      for (const a of animers) a(elapsed, dt)
      // spin windmill blades (frame-rate independent, zero allocation)
      for (let i = 0; i < spinners.length; i++) {
        const s = spinners[i]
        s.obj.rotation[s.axis] += s.speed * dt
      }
    },
    dispose() {
      // remove the root and dispose every geometry/material under it once
      root.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          m.geometry?.dispose()
          const mm = m.material
          if (Array.isArray(mm)) for (const x of mm) x.dispose()
          else mm?.dispose()
        }
      })
      root.parent?.remove(root)
      root.clear()
      animers.length = 0
      spinners.length = 0
    },
  }
}

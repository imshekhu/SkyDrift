import * as THREE from 'three'
import type { RegionDef } from '../core/types'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Regions
//
// The planet is partitioned into 16 named BIOME REGIONS by spherical Voronoi:
// each region owns a "capital" unit-direction, and a surface point belongs to
// the region whose capital it is nearest (largest dot product). Regions give the
// huge world legible PLACES to hang hundreds of tasks on, distinct terrain
// (elevationBias) + colour (tint), a world map, and the streaming unit (P3).
//
// This module is pure data + pure spatial queries — shared by both the planet
// build (Planet.ts colours/raises terrain by region) and the runtime Regions
// system (which region is the player in). Zero per-call allocation in the hot
// query (regionInfluenceAt returns a shared struct). (World plan §3.)
// ─────────────────────────────────────────────────────────────────────────────

interface Template {
  id: string
  name: string
  biome: RegionDef['biome']
  tint: number // sRGB hex the surface is blended toward inside the region
  tintAmount: number // 0..1 strength at the core
  elevationBias: number // -1..1 × relief: desert flat/low, alpine/volcano tall
}

// 16 curated biomes. Capitals are assigned an even spread at build time.
const TEMPLATES: Template[] = [
  // Tints are deliberately SATURATED + tonally separated so each biome reads as a
  // distinct place from the air; the pale ones (desert/tundra/savanna/steppe/alps)
  // carry a higher tintAmount so they don't dissolve into the pale day horizon.
  { id: 'forest-vale', name: 'Forest Vale', biome: 'forest', tint: 0x2f7a38, tintAmount: 0.42, elevationBias: 0.12 },
  { id: 'emerald-meadow', name: 'Emerald Meadow', biome: 'meadow', tint: 0x86c248, tintAmount: 0.42, elevationBias: -0.12 },
  { id: 'verdant-jungle', name: 'Verdant Jungle', biome: 'jungle', tint: 0x156a2c, tintAmount: 0.5, elevationBias: 0.06 },
  { id: 'sunset-savanna', name: 'Sunset Savanna', biome: 'savanna', tint: 0xc78f2c, tintAmount: 0.54, elevationBias: -0.1 },
  { id: 'windswept-steppe', name: 'Windswept Steppe', biome: 'steppe', tint: 0x8fa23e, tintAmount: 0.5, elevationBias: -0.14 },
  { id: 'golden-dunes', name: 'Golden Dunes', biome: 'desert', tint: 0xd8962f, tintAmount: 0.62, elevationBias: -0.06 },
  { id: 'crimson-mesa', name: 'Crimson Mesa', biome: 'mesa', tint: 0xbc5028, tintAmount: 0.58, elevationBias: 0.22 },
  { id: 'ashen-badlands', name: 'Ashen Badlands', biome: 'badlands', tint: 0x86603f, tintAmount: 0.54, elevationBias: 0.08 },
  { id: 'frostcap-peaks', name: 'Frostcap Peaks', biome: 'snow', tint: 0xd6e6f6, tintAmount: 0.6, elevationBias: 0.32 },
  { id: 'tundra-flats', name: 'Tundra Flats', biome: 'tundra', tint: 0x82aaa6, tintAmount: 0.56, elevationBias: -0.05 },
  { id: 'cloudspire-alps', name: 'Cloudspire Alps', biome: 'alpine', tint: 0x74849a, tintAmount: 0.58, elevationBias: 0.36 },
  { id: 'emberpeak', name: 'Emberpeak', biome: 'volcano', tint: 0x782a1a, tintAmount: 0.6, elevationBias: 0.3 },
  { id: 'azure-shoals', name: 'Azure Shoals', biome: 'ocean', tint: 0x2486c8, tintAmount: 0.56, elevationBias: -0.55 },
  { id: 'coral-archipelago', name: 'Coral Archipelago', biome: 'archipelago', tint: 0x3cc0ae, tintAmount: 0.52, elevationBias: -0.34 },
  { id: 'mirror-lakes', name: 'Mirror Lakes', biome: 'lake', tint: 0x489ac6, tintAmount: 0.46, elevationBias: -0.24 },
  { id: 'travelers-rest', name: "Traveler's Rest", biome: 'hub', tint: 0x8ec96a, tintAmount: 0.38, elevationBias: 0.0 },
]

/**
 * Assign each biome template an evenly-spread capital direction (Fibonacci
 * sphere) rotated by a seed-derived rotation, so the layout varies per seed but
 * stays evenly distributed. Call this ONCE in main, right before buildPlanet,
 * and pass the result to BOTH buildPlanet (colour/terrain) and the Regions
 * system (runtime queries) — one seeded source of truth.
 */
export function assignRegions(rand: () => number): RegionDef[] {
  const N = TEMPLATES.length
  const golden = Math.PI * (3 - Math.sqrt(5)) // golden angle
  const axis = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1)
  if (axis.lengthSq() < 1e-6) axis.set(0, 1, 0)
  axis.normalize()
  const rot = new THREE.Quaternion().setFromAxisAngle(axis, rand() * Math.PI * 2)
  const defs: RegionDef[] = []
  for (let i = 0; i < N; i++) {
    const y = 1 - ((i + 0.5) / N) * 2 // -1..1, evenly spaced
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    const cap = new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r).applyQuaternion(rot)
    const t = TEMPLATES[i]
    defs.push({
      id: t.id,
      name: t.name,
      capital: cap,
      biome: t.biome,
      tint: new THREE.Color().setHex(t.tint, THREE.SRGBColorSpace),
      tintAmount: t.tintAmount,
      elevationBias: t.elevationBias,
      streamRadius: 0.62, // radians — live disc for streaming (P3)
      taskSlots: 12,
    })
  }
  return defs
}

/** The region containing a unit direction (nearest capital). O(N), no alloc. */
export function nearestRegion(defs: RegionDef[], dir: THREE.Vector3): RegionDef {
  let best = defs[0]
  let bestDot = -Infinity
  for (let i = 0; i < defs.length; i++) {
    const c = defs[i].capital
    const dot = dir.x * c.x + dir.y * c.y + dir.z * c.z
    if (dot > bestDot) {
      bestDot = dot
      best = defs[i]
    }
  }
  return best
}

// Blended region influence at a point — the dominant region + a colour/terrain
// blend that feathers across borders (so biome seams aren't hard lines).
export interface RegionInfluence {
  region: RegionDef
  bias: number // blended elevationBias (fraction of relief)
  tintR: number
  tintG: number
  tintB: number
  amount: number // blended tint strength
}

const _inf: RegionInfluence = { region: null as unknown as RegionDef, bias: 0, tintR: 0, tintG: 0, tintB: 0, amount: 0 }
const BORDER_SOFT = 0.08 // dot-gap over which two regions blend (wider = softer seams)

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Top-2 nearest capitals → blend toward the dominant one with weight `w`
 * (1 at the core, 0.5 exactly on a border). Returns a SHARED struct — consume
 * its fields before the next call. Pure function of (defs, x, y, z).
 */
export function regionInfluenceAt(defs: RegionDef[], x: number, y: number, z: number): RegionInfluence {
  let i1 = 0
  let i2 = 0
  let d1 = -Infinity
  let d2 = -Infinity
  for (let i = 0; i < defs.length; i++) {
    const c = defs[i].capital
    const dot = x * c.x + y * c.y + z * c.z
    if (dot > d1) {
      d2 = d1
      i2 = i1
      d1 = dot
      i1 = i
    } else if (dot > d2) {
      d2 = dot
      i2 = i
    }
  }
  const r1 = defs[i1]
  const r2 = defs[i2]
  const w = 0.5 + 0.5 * smoothstep(0, BORDER_SOFT, d1 - d2) // 1 core → 0.5 border
  const iw = 1 - w
  _inf.region = r1
  _inf.bias = r1.elevationBias * w + r2.elevationBias * iw
  _inf.tintR = r1.tint.r * w + r2.tint.r * iw
  _inf.tintG = r1.tint.g * w + r2.tint.g * iw
  _inf.tintB = r1.tint.b * w + r2.tint.b * iw
  _inf.amount = r1.tintAmount * w + r2.tintAmount * iw
  return _inf
}

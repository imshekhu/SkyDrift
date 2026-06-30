import * as THREE from 'three'
import { createNoise3D } from 'simplex-noise'
import alea from 'alea'
import type { Planet, GameSystem, GameContext, RegionDef } from '../core/types'
import { PAL } from '../art/palette'
import { AUTHORED_RADIUS } from './WorldConfig'
import { regionInfluenceAt } from './regions'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Planet
//
// A cozy low-poly pastel globe: an icosahedron displaced by FBM simplex noise,
// vertex-colored by elevation into water/sand/grass/forest/rock/snow bands, with
// a translucent inner water sphere that gently bobs. The SAME noise field powers
// both the displaced mesh AND heightAt(), so anything placed with surfacePoint()
// sits exactly on the terrain.
//
// POLISH PASS — richer biomes:
//   • Domain-warped coastlines so beaches wiggle organically instead of ringing.
//   • Sandy beaches that hug the true shoreline + a soft sub-water shoal.
//   • Snow caps that respect altitude AND latitude (poles get a frosting too).
//   • Subtle inland rivers/lakes carved by a separate low-freq moisture channel.
//   • Smoother coast→grass→forest→rock blending with hand-painted value jitter.
//   • Prettier translucent water: lighter foam near shores, two-band shimmer.
//
// buildPlanet() is NOT a GameSystem — main() calls it once to build ctx.planet.
// createPlanetWaterSystem() IS a GameSystem that animates the water bob.
// Zero per-frame allocation in update(); mobile-perf-conscious throughout.
// ─────────────────────────────────────────────────────────────────────────────

// --- terrain shaping (all relative to planet radius) -------------------------
const GEO_DETAIL = 7 // icosa subdivisions: ~980k tris — base tier (P3 adds high-detail region chunks)
const NOISE_FREQ = 1.5 // base spatial frequency of the FBM field
const FBM_OCTAVES = 4
const FBM_LACUNARITY = 2.0
const FBM_GAIN = 0.5
const RELIEF = 0.085 // max displacement as a fraction of radius
const SEA_LEVEL = 0.0 // elevation (in displacement units) below which is ocean
const WARP = 0.35 // domain-warp strength for organic, wiggly coastlines

// Water-band heights (fraction of radius). Inner sphere sits just below sea level
// so beaches read as a thin sand rim around the displaced land.
const WATER_INSET = 0.004 // inner water sphere sits this far below the mean radius

// Pastel biome ramp — authored as sRGB so AgX tone mapping behaves.
const sc = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)
const BIOME = {
  waterDeep: sc(0x4f86c6),
  waterShallow: sc(0x7fb4e0),
  shoal: sc(0xb6dcec), // pale turquoise just under the shoreline
  sandWet: sc(0xd9b878), // damp sand — deepened so deserts/beaches read warm, not pale
  sand: sc(0xe6cb86), // dry sand — richer/warmer than the old near-cream so it pops vs the sky
  grass: PAL.planet.clone(), // cohesion: same green as PAL.planet
  meadow: sc(0xa6cf68), // richer lowland grass (deepened for biome contrast)
  forest: PAL.tree.clone(),
  rock: sc(0x9a8f86),
  rockDark: sc(0x7d756e), // shaded rock for craggy high slopes
  snow: sc(0xf4f0f7),
  river: sc(0x3fb8f0), // inland freshwater — bright, saturated blue-cyan so waterways read clearly vs land
}

// ── SMOOTH-SPHERE MODE (SKYDRIFT-MINIMAL) ─────────────────────────────────────
// true → no terrain displacement, no noise bumps, one solid colour, no water
// shell. heightAt() returns 0 everywhere, so flight's terrain-relative altitude
// collapses to a fixed, rock-steady cruise. Flip to false to restore the full
// FBM/biome/river/water planet — every original line is intact, just guarded.
const FLAT_PLANET = true
const FLAT_COLOR = sc(0x6fae5f) // pleasant solid green
// FLAT_WATER (only meaningful when FLAT_PLANET): carve shallow seas + lakes into
// the smooth globe and fill them with the animated translucent water shell. Keeps
// the clean low-poly look — basins are gentle, no mountainous terrain returns.
const FLAT_WATER = false // ← OFF for now: a completely smooth green sphere (water WIP)
// Recess the green "core" a few units below the base radius so the blue Crust
// shell can sit at the EXACT surface radius (= where placed items sit) without
// z-fighting the core beneath it. Purely visual — heightAt() still returns 0.
export const FLAT_CORE_GAP = 6
const FLAT_SEABED = sc(0xc9b886) // warm sandy seabed → turquoise shallows under blue water
const FLAT_WATER_DEEP = sc(0x356bb0) // a deeper, richer blue for open-sea centres

// Elevation thresholds in NORMALIZED elevation space e∈[0,1] (0 = deepest, 1 = peak).
// Land starts at SHORE; below that is ocean floor (hidden under the water sphere).
const SHORE = 0.5
const SAND_TOP = 0.545
const GRASS_TOP = 0.66
const FOREST_TOP = 0.8
const ROCK_TOP = 0.92

export function buildPlanet(radius: number, rand: () => number, regions?: RegionDef[]): Planet {
  // Deterministic noise seeded from the game's RNG so the same seed → same world.
  const seed = Math.floor(rand() * 0xffffffff) >>> 0
  const noise3D = createNoise3D(alea(seed))
  // A second decorrelated field drives domain-warp + rivers (offset seed).
  const noiseWarp = createNoise3D(alea((seed ^ 0x9e3779b9) >>> 0))

  // ── FLAT-WATER fields (smooth-globe seas + lakes) ──────────────────────────
  // A slow large-scale field carves continental seas; a sparse high-freq field
  // dots inland lakes onto the dry land. Pure functions of direction → the land
  // carve, the seabed colour and the water shell colour all agree exactly.
  const SEA_FREQ = 0.85
  const seaFbm = (x: number, y: number, z: number): number => {
    let amp = 1
    let f = SEA_FREQ
    let sum = 0
    let norm = 0
    for (let o = 0; o < 3; o++) {
      sum += amp * noise3D(x * f + 100.0, y * f + 100.0, z * f + 100.0)
      norm += amp
      amp *= 0.5
      f *= 2.0
    }
    return sum / norm // ∈ [-1,1]
  }
  const LAKE_FREQ = 3.2
  const lakeFbm = (x: number, y: number, z: number): number =>
    noise3D(x * LAKE_FREQ - 60.0, y * LAKE_FREQ + 24.0, z * LAKE_FREQ - 12.0)

  const SEA_THRESHOLD = -0.08 // seaFbm below this → ocean (~40% of the globe)
  const SEA_DEPTH_SPAN = 0.42 // how quickly the sea deepens past the shore
  // Water depth ∈ [0,1]: 0 = dry land, 1 = deepest. Seas from the slow field +
  // sparse lakes on land away from the coast.
  const waterDepthFlat = (x: number, y: number, z: number): number => {
    const s = seaFbm(x, y, z)
    if (s < SEA_THRESHOLD) return clamp01((SEA_THRESHOLD - s) / SEA_DEPTH_SPAN)
    // dry land: scatter the occasional lake, kept clear of the coastline.
    if (s > SEA_THRESHOLD + 0.12) {
      const lv = lakeFbm(x, y, z)
      if (lv > 0.6) return clamp01((lv - 0.6) / 0.25) * 0.7
    }
    return 0
  }

  // The water shell floats a hair ABOVE the smooth green plain (and is built ONLY
  // over water regions), so it can never z-fight or get "absorbed" into the land
  // as the waves bob — the wave trough still clears the plain. No basins carved.
  const FLAT_WATER_LIFT = radius * 0.004 // water surface sits this far ABOVE the plain
  const FLAT_BEACH = 0.05 // water-depth span painted as sandy beach at the shore

  // FBM sampled on the UNIT sphere direction. Returns signed elevation in ~[-1,1]
  // before the RELIEF scale. Pulled out so heightAt() and the mesh agree exactly.
  // NOTE: closes over fixed module constants only — pure function of (x,y,z).
  const fbm = (x: number, y: number, z: number): number => {
    let amp = 1
    let freq = NOISE_FREQ
    let sum = 0
    let norm = 0
    for (let o = 0; o < FBM_OCTAVES; o++) {
      sum += amp * noise3D(x * freq, y * freq, z * freq)
      norm += amp
      amp *= FBM_GAIN
      freq *= FBM_LACUNARITY
    }
    return sum / norm // ∈ [-1, 1]
  }

  // Signed terrain elevation (in world units) above the base radius for a unit dir.
  // Continents are biased upward and oceans flattened a touch via a soft curve so
  // there's clear land vs. sea rather than uniform bumpiness. A low-freq domain
  // warp displaces the sample point so coastlines meander instead of ringing
  // around the noise lattice — cheap (one extra field) but a big readability win.
  const elevationAt = (x: number, y: number, z: number): number => {
    // Domain warp: nudge the lookup by a slow, smooth offset field.
    const wf = NOISE_FREQ * 0.6
    const wx = x + WARP * noiseWarp(x * wf + 11.3, y * wf, z * wf)
    const wy = y + WARP * noiseWarp(x * wf, y * wf + 7.1, z * wf)
    const wz = z + WARP * noiseWarp(x * wf, y * wf, z * wf + 3.7)
    const n = fbm(wx, wy, wz) // [-1,1]
    // Ridge-ish continental shaping: push mid values toward land, keep valleys low.
    const shaped = Math.sign(n) * Math.pow(Math.abs(n), 0.85)
    let e = shaped * RELIEF * radius
    // Region terrain identity: raise/lower mean land height per biome region
    // (desert flat, alpine/volcano tall, ocean sunk below sea level), feathered
    // at borders. Folded into elevationAt so heightAt()/placement match the mesh.
    if (regions) e += regionInfluenceAt(regions, x, y, z).bias * RELIEF * radius
    return e
  }

  // Inland water mask in [0,1]: 1 where a river/lake should carve a shallow basin.
  // Driven by a thin "valley" band of the warp field intersected with low-to-mid
  // land so peaks stay dry and oceans aren't double-counted. Pure function of dir.
  const riverMask = (x: number, y: number, z: number, eNorm: number): number => {
    if (eNorm <= SHORE + 0.01 || eNorm > FOREST_TOP) return 0
    const rf = NOISE_FREQ * 1.1
    const v = noiseWarp(x * rf + 41.0, y * rf - 17.0, z * rf + 5.0)
    // Ridge where |v| is small → sinuous waterways. Widened threshold so rivers
    // read as broad blue channels (with tributaries) rather than hairlines.
    const channel = 1 - Math.min(1, Math.abs(v) / 0.16)
    if (channel <= 0) return 0
    // Fade rivers out as land climbs toward forest (they pool in lowlands).
    const lowland = clamp01((FOREST_TOP - eNorm) / (FOREST_TOP - SHORE))
    return channel * channel * lowland
  }

  // --- public heightAt: terrain height above base radius for a unit direction ---
  // Land sits at/above 0; ocean floor returns a small negative (clamped at -inset)
  // so surfacePoint() over water lands on the visible water shell, not the seabed.
  // (River basins are a thin cosmetic dip handled in the mesh only — heightAt
  //  stays a pure function of elevationAt so gameplay placement is unchanged.)
  const heightAt = (dir: THREE.Vector3): number => {
    if (FLAT_PLANET) return 0 // smooth sphere → fixed-altitude cruise
    const x = dir.x
    const y = dir.y
    const z = dir.z
    const e = elevationAt(x, y, z)
    if (e < SEA_LEVEL) return -WATER_INSET * radius
    return e
  }

  // --- public surfacePoint: world point on the surface (+ optional altitude) ----
  // Zero-allocation: writes into `out` when provided, otherwise into _spOut.
  // Callers that don't pass `out` must consume the result before the next call.
  const _spDir = new THREE.Vector3()
  const _spOut = new THREE.Vector3()
  const surfacePoint = (dir: THREE.Vector3, extra?: number, out?: THREE.Vector3): THREE.Vector3 => {
    _spDir.copy(dir).normalize()
    const r = radius + heightAt(_spDir) + (extra ?? 0)
    const target = out ?? _spOut
    target.set(_spDir.x * r, _spDir.y * r, _spDir.z * r)
    return target
  }

  // ── Build the displaced, vertex-colored land mesh ──────────────────────────
  // toNonIndexed() gives every triangle its own vertices → crisp flat-shaded
  // facets and per-face biome colors without seams.
  const geo = new THREE.IcosahedronGeometry(radius, GEO_DETAIL).toNonIndexed()
  const pos = geo.attributes.position as THREE.BufferAttribute
  const vCount = pos.count
  const colors = new Float32Array(vCount * 3)

  // Reusable scratch — no allocation inside the vertex loop.
  const dir = new THREE.Vector3()
  const col = new THREE.Color()
  const tmp = new THREE.Color()

  // Track elevation range to normalize biome banding to the actual relief.
  // First pass: displace + record signed elevation per vertex.
  const elevWorld = new Float32Array(vCount)
  let eMin = Infinity
  let eMax = -Infinity
  for (let i = 0; i < vCount; i++) {
    dir.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize()
    const e = elevationAt(dir.x, dir.y, dir.z) // signed world units
    if (e < eMin) eMin = e
    if (e > eMax) eMax = e
    elevWorld[i] = e
  }
  const eRange = eMax - eMin || 1

  for (let i = 0; i < vCount; i++) {
    dir.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize()
    const eWorld = elevWorld[i]
    const e = (eWorld - eMin) / eRange // normalized 0..1

    // Inland water: carve a thin basin so rivers/lakes read as recessed water.
    const river = riverMask(dir.x, dir.y, dir.z, e)

    // Displace: ocean floor clamps to the water shell so the seabed never pokes
    // through the translucent water; land follows terrain. River basins dip a
    // hair below their surroundings (cosmetic only — heightAt() ignores this).
    let h = eWorld < SEA_LEVEL ? -WATER_INSET * radius : eWorld
    if (river > 0) h -= river * RELIEF * radius * 0.12
    // FLAT_WATER keeps the globe perfectly smooth — NO basins carved. The water
    // shell floats just above the plain (built only over water), so it never digs
    // into or z-fights the land. flatWd only drives the beach/seabed COLOUR here.
    const flatWd = FLAT_PLANET && FLAT_WATER ? waterDepthFlat(dir.x, dir.y, dir.z) : 0
    const r = FLAT_PLANET ? radius - FLAT_CORE_GAP : radius + h
    pos.setXYZ(i, dir.x * r, dir.y * r, dir.z * r)

    // Latitude (|y| of the unit dir) frosts the poles regardless of altitude.
    const lat = Math.abs(dir.y)

    if (FLAT_PLANET) {
      // Smooth globe: solid green plain, with sandy beaches + a seabed gradient
      // wherever FLAT_WATER carved a basin (the seabed shows through the water).
      if (FLAT_WATER && flatWd > 0.001) {
        if (flatWd <= FLAT_BEACH) {
          col.copy(FLAT_COLOR).lerp(tmp.copy(BIOME.sand), smooth(flatWd / FLAT_BEACH))
        } else {
          const t = smooth(clamp01((flatWd - FLAT_BEACH) / (0.6 - FLAT_BEACH)))
          col.copy(BIOME.sand).lerp(tmp.copy(FLAT_SEABED), t)
        }
      } else {
        col.copy(FLAT_COLOR)
      }
      const j = 1 + (hash01(i) - 0.5) * 0.05
      colors[i * 3] = Math.min(1, col.r * j)
      colors[i * 3 + 1] = Math.min(1, col.g * j)
      colors[i * 3 + 2] = Math.min(1, col.b * j)
    } else {
      // Pick + blend biome by band for soft pastel transitions.
      biomeColor(e, lat, river, col, tmp)

      // Region tint: push the surface colour toward this region's hue (feathered
      // at borders) so each biome region reads as a distinct PLACE from the air.
      if (regions) {
        const inf = regionInfluenceAt(regions, dir.x, dir.y, dir.z)
        const a = inf.amount
        col.r = col.r * (1 - a) + inf.tintR * a
        col.g = col.g * (1 - a) + inf.tintG * a
        col.b = col.b * (1 - a) + inf.tintB * a
      }

      // Subtle per-vertex value jitter for a hand-painted feel (deterministic).
      const j = 1 + (hash01(i) - 0.5) * 0.06
      colors[i * 3] = Math.min(1, col.r * j)
      colors[i * 3 + 1] = Math.min(1, col.g * j)
      colors[i * 3 + 2] = Math.min(1, col.b * j)
    }
  }

  pos.needsUpdate = true
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()

  const landMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: !FLAT_PLANET, // SKYDRIFT-MINIMAL: smooth-shade the flat sphere
    roughness: 1.0,
    metalness: 0.0,
  })
  const landMesh = new THREE.Mesh(geo, landMat)
  landMesh.name = 'planet-land'
  landMesh.castShadow = false
  landMesh.receiveShadow = false

  // ── Translucent water shell (gentle bob animated by the water system) ───────
  // FLAT_WATER: build the shell ONLY over water regions and float it a hair ABOVE
  // the smooth plain, so it can NEVER z-fight the land or get "absorbed" into the
  // sphere as the waves bob (the wave trough still clears the plain, and there's no
  // water geometry over dry ground). Otherwise it's the classic just-below-sea-
  // level shell the opaque land hides over dry ground.
  const flatWater = FLAT_PLANET && FLAT_WATER
  const waterRadius = flatWater ? radius + FLAT_WATER_LIFT : radius - WATER_INSET * radius
  const srcWaterGeo = new THREE.IcosahedronGeometry(waterRadius, flatWater ? 5 : 4)
  const wDir = new THREE.Vector3()
  const wCol = new THREE.Color()
  const wTmp = new THREE.Color()
  const colorWaterVert = (x: number, y: number, z: number): void => {
    wDir.set(x, y, z).normalize()
    const wd = waterDepthFlat(wDir.x, wDir.y, wDir.z)
    // Pale shoal at the very rim, then quickly into shallow → deep blue.
    if (wd < 0.12) wCol.copy(BIOME.shoal).lerp(wTmp.copy(BIOME.waterShallow), clamp01(wd / 0.12))
    else wCol.copy(BIOME.waterShallow).lerp(wTmp.copy(FLAT_WATER_DEEP), clamp01((wd - 0.12) / 0.5))
  }

  let waterGeo: THREE.BufferGeometry
  if (flatWater) {
    // Keep only the triangles whose centre lies over water → the shell exists
    // solely above the seas/lakes, never over (or inside) the green land.
    const sp = srcWaterGeo.attributes.position as THREE.BufferAttribute
    const triCount = (sp.count / 3) | 0
    const keepPos: number[] = []
    const keepCol: number[] = []
    const cdir = new THREE.Vector3()
    for (let t = 0; t < triCount; t++) {
      const a = t * 3
      const b = t * 3 + 1
      const c = t * 3 + 2
      cdir
        .set(
          sp.getX(a) + sp.getX(b) + sp.getX(c),
          sp.getY(a) + sp.getY(b) + sp.getY(c),
          sp.getZ(a) + sp.getZ(b) + sp.getZ(c)
        )
        .normalize()
      if (waterDepthFlat(cdir.x, cdir.y, cdir.z) <= 0.02) continue // dry → drop the tri
      for (const ii of [a, b, c]) {
        const x = sp.getX(ii)
        const y = sp.getY(ii)
        const z = sp.getZ(ii)
        keepPos.push(x, y, z)
        colorWaterVert(x, y, z)
        keepCol.push(wCol.r, wCol.g, wCol.b)
      }
    }
    waterGeo = new THREE.BufferGeometry()
    waterGeo.setAttribute('position', new THREE.Float32BufferAttribute(keepPos, 3))
    waterGeo.setAttribute('color', new THREE.Float32BufferAttribute(keepCol, 3))
    waterGeo.computeVertexNormals()
    srcWaterGeo.dispose()
  } else {
    waterGeo = srcWaterGeo
    const wPos = waterGeo.attributes.position as THREE.BufferAttribute
    const wCount = wPos.count
    const wColors = new Float32Array(wCount * 3)
    for (let i = 0; i < wCount; i++) {
      wDir.set(wPos.getX(i), wPos.getY(i), wPos.getZ(i)).normalize()
      const e = elevationAt(wDir.x, wDir.y, wDir.z)
      const depth = clamp01(-e / (RELIEF * radius * 0.5))
      if (depth > 0.45) {
        wCol.copy(BIOME.waterDeep).lerp(wTmp.copy(BIOME.waterShallow), clamp01((1 - depth) / 0.55))
      } else {
        const t = clamp01((0.45 - depth) / 0.45)
        wCol.copy(BIOME.waterShallow).lerp(wTmp.copy(BIOME.shoal), t)
      }
      wColors[i * 3] = wCol.r
      wColors[i * 3 + 1] = wCol.g
      wColors[i * 3 + 2] = wCol.b
    }
    waterGeo.setAttribute('color', new THREE.BufferAttribute(wColors, 3))
  }

  const waterMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.86,
    roughness: 0.4, // diffuse blue dominates; still a soft glint off the wave facets
    metalness: 0.0,
    flatShading: true,
    envMapIntensity: 0.6,
  })
  const waterMesh = new THREE.Mesh(waterGeo, waterMat)
  waterMesh.name = 'planet-water'
  waterMesh.renderOrder = 1 // draw after land so blending reads correctly

  // Group both; cast as Mesh to satisfy the Planet contract (mesh: THREE.Mesh).
  // Group is fine here — main() only ever adds ctx.planet.mesh to the scene.
  const group = new THREE.Group()
  group.name = 'planet'
  group.add(landMesh)
  if (!FLAT_PLANET || FLAT_WATER) group.add(waterMesh) // seas/lakes shell

  const planet: Planet = {
    radius,
    scale: radius / AUTHORED_RADIUS, // multiply authored (radius-100) lengths by this
    relief: RELIEF * radius, // max terrain displacement above base radius (world units)
    mesh: group as unknown as THREE.Mesh,
    heightAt,
    surfacePoint,
  }
  return planet
}

// ── Biome color lookup: writes the blended color into `out` ────────────────────
// `scratch` is a caller-provided Color used for lerping (no allocation).
//   e     — normalized elevation 0..1
//   lat   — |y| of the unit direction 0..1 (poles → 1) for latitude frosting
//   river — inland-water mask 0..1; >0 overrides land with freshwater
function biomeColor(
  e: number,
  lat: number,
  river: number,
  out: THREE.Color,
  scratch: THREE.Color,
): void {
  if (e < SHORE) {
    // Underwater floor: deep→shallow gradient toward the shoreline.
    const t = clamp01(e / SHORE)
    out.copy(BIOME.waterDeep).lerp(scratch.copy(BIOME.waterShallow), t)
    return
  } else if (e < SAND_TOP) {
    // Beach: damp sand at the waterline → dry sand inland for a real shoreline.
    const t = clamp01((e - SHORE) / (SAND_TOP - SHORE))
    out.copy(BIOME.sandWet).lerp(scratch.copy(BIOME.sand), smooth(t))
  } else if (e < GRASS_TOP) {
    // Lowland grass: brighter meadow near the beach → richer grass uphill.
    const t = clamp01((e - SAND_TOP) / (GRASS_TOP - SAND_TOP))
    // Quick sand→meadow fade in the first sliver so beaches melt into green.
    if (t < 0.18) {
      out.copy(BIOME.sand).lerp(scratch.copy(BIOME.meadow), smooth(t / 0.18))
    } else {
      out.copy(BIOME.meadow).lerp(scratch.copy(BIOME.grass), smooth((t - 0.18) / 0.82))
    }
  } else if (e < FOREST_TOP) {
    const t = clamp01((e - GRASS_TOP) / (FOREST_TOP - GRASS_TOP))
    out.copy(BIOME.grass).lerp(scratch.copy(BIOME.forest), smooth(t))
  } else if (e < ROCK_TOP) {
    // Forest→rock, with darker rock on the upper crags.
    const t = clamp01((e - FOREST_TOP) / (ROCK_TOP - FOREST_TOP))
    out.copy(BIOME.forest).lerp(scratch.copy(BIOME.rock), smooth(t))
    if (t > 0.5) out.lerp(scratch.copy(BIOME.rockDark), smooth((t - 0.5) / 0.5) * 0.5)
  } else {
    const t = clamp01((e - ROCK_TOP) / (1 - ROCK_TOP))
    out.copy(BIOME.rock).lerp(scratch.copy(BIOME.snow), smooth(t))
  }

  // Latitude frosting: dust snow onto land near the poles, strongest on high
  // ground. Lat starts mattering past ~0.78 so equatorial coasts stay green.
  if (e >= SAND_TOP) {
    const polar = clamp01((lat - 0.78) / 0.22)
    if (polar > 0) {
      const altBoost = clamp01((e - SAND_TOP) / (1 - SAND_TOP))
      const snowAmt = clamp01(polar * (0.35 + 0.65 * altBoost))
      out.lerp(scratch.copy(BIOME.snow), smooth(snowAmt))
    }
  }

  // Inland freshwater: carved rivers/lakes paint over land as bright blue.
  // Boost the mask before smoothing so strong-mask vertices lerp to (near-)full
  // river colour — the channel core reads as solid water, banks fade to land.
  if (river > 0) {
    out.lerp(scratch.copy(BIOME.river), smooth(clamp01(river * 1.6)))
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// Smoothstep — softens linear lerp params into gentle pastel transitions.
function smooth(t: number): number {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

// Cheap deterministic hash → [0,1) for per-vertex jitter (no allocation).
function hash01(i: number): number {
  let x = (i + 1) * 374761393
  x = (x ^ (x >>> 13)) * 1274126177
  x = x ^ (x >>> 16)
  return (x >>> 0) / 4294967296
}

// ─────────────────────────────────────────────────────────────────────────────
// Water bob system — gently undulates the inner water sphere's vertices.
// Pure function of base position + elapsed time → no drift, no per-frame alloc.
// Three interfering swell bands + a fast high-freq shimmer give a soft, lively
// sea that never tiles. Amplitude is tiny so it reads as a calm breathing ocean.
// ─────────────────────────────────────────────────────────────────────────────
export function createPlanetWaterSystem(planet: Planet): GameSystem {
  // Reusable temps captured at module/closure scope — zero allocation in update().
  let water: THREE.Mesh | null = null
  let basePos: Float32Array | null = null
  let attr: THREE.BufferAttribute | null = null
  let baseRadius = planet.radius

  // Bob tuning — small swell so flat-shaded facets tilt (the glint dances as they
  // move; flatShading derives the normals, so no recompute needed). Kept well
  // under FLAT_WATER_LIFT so the wave trough always clears the plain → no z-fight.
  const AMP = planet.radius * 0.0014
  const SHIMMER = planet.radius * 0.0005 // faster ripple layered on the swell
  const SPATIAL = 11.0 // wave count around the sphere — choppier → livelier glint
  const TIME_FREQ = 0.9 // wave speed
  const UPDATE_HZ = 30 // throttle vertex writes (plenty smooth, kinder to mobile)
  let accum = 0

  return {
    name: 'planet-water',
    init(_ctx: GameContext): void {
      const group = planet.mesh as unknown as THREE.Object3D
      const found = group.getObjectByName?.('planet-water') as THREE.Mesh | undefined
      if (!found) return
      water = found
      attr = water.geometry.attributes.position as THREE.BufferAttribute
      const src = attr.array as Float32Array
      basePos = new Float32Array(src.length)
      basePos.set(src)
      // Derive the shell radius from its own geometry so this works for the
      // classic sea-level shell AND the FLAT_WATER (just-below-plain) shell.
      baseRadius = Math.hypot(src[0], src[1], src[2]) || planet.radius
    },
    update(dt: number, ctx: GameContext): void {
      if (!water || !basePos || !attr) return
      // Throttle: accumulate dt, only rewrite vertices a few times/sec.
      accum += dt
      if (accum < 1 / UPDATE_HZ) return
      accum = 0

      const t = ctx.elapsed() * TIME_FREQ
      const arr = attr.array as Float32Array
      const n = basePos.length
      // Interfering sine bands along the sphere give a soft, non-tiling swell,
      // with a faster, higher-frequency shimmer on top for sparkle.
      for (let i = 0; i < n; i += 3) {
        const bx = basePos[i]
        const by = basePos[i + 1]
        const bz = basePos[i + 2]
        // Unit dir (base sphere is exactly baseRadius, so /baseRadius == normalize)
        const ux = bx / baseRadius
        const uy = by / baseRadius
        const uz = bz / baseRadius
        const swell =
          Math.sin(ux * SPATIAL + t) * 0.5 +
          Math.sin((uy + uz) * SPATIAL * 0.75 - t * 1.3) * 0.5
        const shimmer =
          Math.sin((ux + uy) * SPATIAL * 2.7 + t * 2.4) *
          Math.sin((uz - ux) * SPATIAL * 2.3 - t * 1.9)
        const r = baseRadius + swell * AMP + shimmer * SHIMMER
        arr[i] = ux * r
        arr[i + 1] = uy * r
        arr[i + 2] = uz * r
      }
      attr.needsUpdate = true
      // No normal recompute: the material is flatShading, so face normals are
      // derived in-shader from the (now-moved) positions → the glint already
      // shimmers as the facets tilt, for free.
    },
    dispose(): void {
      water = null
      basePos = null
      attr = null
    },
  }
}

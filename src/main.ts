import * as THREE from 'three'
import { PAL } from './art/palette'
import { input, initKeyboard, pollKeyboard } from './controls/input'
import { Flight, PLANET_RADIUS, TUNING } from './plane/flight'
import { updateChaseCamera } from './plane/camera'
import { CAMERA_FAR, WORLD_SCALE } from './world/WorldConfig'

import type { GameContext, Player } from './core/types'
import { Game } from './core/Game'
import { createEventBus } from './core/EventBus'
import { createHudBus } from './core/HudBus'

import { buildPlanet, createPlanetWaterSystem } from './world/Planet'
import { assignRegions } from './world/regions'
import { createComposer } from './post/Composer'

// --- Systems (registration order matters — see the game.add() block below) ---
import { createLightingSystem } from './systems/Lighting'
import { createSkySystem } from './systems/Sky'
import { createCelestialSystem } from './systems/Celestial'
import { createRegionSystem } from './systems/Regions'
import { createWeatherSystem } from './systems/Weather'
import { createSkyExtrasSystem } from './systems/SkyExtras'
import { createScenerySystem } from './systems/Scenery'
import { createLandmarksSystem } from './systems/Landmarks'
import { createMonumentSystem } from './systems/Monuments'
import { createNpcLifeSystem } from './systems/NpcLife'
import { createProgressionSystem } from './systems/Progression'
import { createBoostSystem } from './systems/Boost'
import { createCollectiblesSystem } from './systems/Collectibles'
import { createVehiclesSystem } from './systems/Vehicles'
import { createPaintballSystem } from './systems/Paintball'
import { WeaponSystem } from './systems/Combat'
import { createTrailsSystem } from './systems/Trails'
import { createPackageQuestSystem } from './systems/QuestPackage'
import { createSelfieQuestSystem } from './systems/QuestSelfie'
import { createRaceSystem } from './systems/QuestRace'
import { createPortalsSystem } from './systems/WorldsPortals'
import { createHudSystem } from './systems/Hud'
import { createAudioSystem } from './systems/Audio'
import { createMultiplayerSystem } from './systems/Multiplayer'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — integration entry point.
//
// main() builds the renderer/scene/camera (NO lights here — the Lighting system
// owns the entire ≤3-light rig), the planet via buildPlanet(), a single
// GameContext, then registers every GameSystem in a sensible order and runs the
// Phase-0 flight loop. The original flight feel is preserved verbatim:
//   clock dt → pollKeyboard() → flight.update → game.update(dt)
//            → updateChaseCamera → renderer.render
// ─────────────────────────────────────────────────────────────────────────────

// --- Renderer ---------------------------------------------------------------
const canvas = document.getElementById('app') as HTMLCanvasElement
const iosBadAA = /OS 16_[1-4]/.test(navigator.userAgent)
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: !iosBadAA,
  alpha: false,
  powerPreference: 'high-performance',
  stencil: false,
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)) // DPR cap 2 — never 3
renderer.setSize(window.innerWidth, window.innerHeight, false)
renderer.toneMapping = THREE.AgXToneMapping // preserves saturated low-poly palette
renderer.toneMappingExposure = 1.0

// --- Scene ------------------------------------------------------------------
const scene = new THREE.Scene()
// Sky.ts adopts (and then owns) this fog if present; we seed it so the very first
// frame — before Sky.init() runs — already clears to the horizon colour (no pop).
scene.fog = new THREE.Fog(PAL.skyHorizon, 220 * WORLD_SCALE, 650 * WORLD_SCALE)
renderer.setClearColor(PAL.skyHorizon, 1)

const camera = new THREE.PerspectiveCamera(
  TUNING.CAM_FOV_BASE,
  window.innerWidth / window.innerHeight,
  0.5,
  CAMERA_FAR // keep > Sky/Portals dome radius (both derived from world size in WorldConfig)
)
camera.position.set(-16, PLANET_RADIUS + 24 * WORLD_SCALE, 0)

// --- Post-processing composer ------------------------------------------------
// Global grade + high-threshold bloom + vignette, drawn instead of a raw
// renderer.render(). Exactly two full-screen passes; DPR stays capped at 2.
// The grade pass folds AgX tone mapping + sRGB encode in itself, so the scene is
// rendered into a linear buffer and finished here (renderer.toneMappingExposure
// remains the single exposure authority — the composer reads it live).
const composer = createComposer(renderer, scene, camera)

// NOTE: NO lights are created here. createLightingSystem() adds the single
// DirectionalLight + HemisphereLight + AmbientLight rig in its init(); Sky,
// Celestial and Portals then discover and drive those existing lights.

// --- Seeded RNG -------------------------------------------------------------
// One deterministic stream shared by every system via ctx.rand(); a fixed seed
// makes the whole world reproducible. (Park–Miller minimal-standard LCG.)
let _seed = 0x5eed1f7 >>> 0
function rand(): number {
  _seed = (_seed * 16807) % 2147483647
  return (_seed & 0x7fffffff) / 2147483647
}

// --- Planet -----------------------------------------------------------------
// buildPlanet() is NOT a GameSystem — it builds ctx.planet once. Its mesh is a
// Group (land + water) cast to THREE.Mesh per the Planet contract; we only ever
// scene.add() it, so the cast is safe.
// Assign 16 biome-region capitals from the seed BEFORE the planet so the planet
// can colour + raise terrain per region, and the Regions system queries the same
// capitals (one seeded source of truth — keeps colours and runtime queries in sync).
const regions = assignRegions(rand)
const planet = buildPlanet(PLANET_RADIUS, rand, regions)
scene.add(planet.mesh)

// --- Player -----------------------------------------------------------------
// The flight object is an empty Group: the Vehicles system parents the real
// biplane/carpet rigs under ctx.player.obj, so we do NOT build a placeholder
// plane mesh here (that would render a doubled craft).
const planeObj = new THREE.Group()
planeObj.name = 'player'
scene.add(planeObj)

const flight = new Flight(planeObj) // seeds spawn transform (nose +Z, +Y radial out)
flight.terrainHeightAt = (d) => planet.heightAt(d) // hard floor follows the terrain

// Player.boosting is `readonly boolean` in the contract; expose it as a live
// getter so any system reading ctx.player.boosting sees the current flight state.
const player: Player = {
  obj: planeObj,
  flight,
  get boosting() {
    return flight.boosting
  },
}

// --- Buses ------------------------------------------------------------------
const events = createEventBus()
const hud = createHudBus()

// Build the REAL audio system+bus BEFORE the context so ctx.audio is the live
// AudioBus (not the null bus) for every system at init() time.
const { system: audioSystem, bus: audioBus } = createAudioSystem()

initKeyboard()

// Optional multiplayer relay URL from Vite's env (untyped here to avoid needing
// the vite/client ambient types; undefined → Multiplayer stays a no-op).
const MP_URL: string | undefined = (import.meta as any).env?.VITE_MP_URL

// --- Elapsed clock ----------------------------------------------------------
const startMs = performance.now()
const elapsed = () => (performance.now() - startMs) / 1000

// --- GameContext ------------------------------------------------------------
const ctx: GameContext = {
  scene,
  camera,
  renderer,
  planet,
  player,
  input,
  audio: audioBus,
  hud,
  events,
  rand,
  elapsed,
}

// --- Shared (ctx as any) field contracts ------------------------------------
// Several systems read/write untyped shared fields off the context. Initialize
// them up front so every system's init() and first-frame update() see a defined
// shape regardless of registration order:
//   • upgrades   — Progression owns; Collectibles/Boost/Paintball read live mults.
//   • progress   — Progression owns; Hud reads the XP/level readout.
//   • boost      — legacy alias; Boost publishes the authoritative `boostActive`.
//   • boostActive— Boost owns; Trails/Hud read it (fall back to player.boosting).
//   • landmarks  — Landmarks publishes; QuestSelfie consumes.
//   • npcTargets — NpcLife publishes; Paintball consumes.
//   • score      — Paintball increments on target hits.
const anyCtx = ctx as any
anyCtx.upgrades = { speedMult: 1, magnet: 1, boostCap: 1, xpMult: 1, fireMult: 1 }
anyCtx.progress = { xp: 0, level: 1, xpToNext: 10 }
anyCtx.boost = false
anyCtx.boostActive = false
anyCtx.landmarks = []
anyCtx.npcTargets = []
anyCtx.score = 0
// weather — Weather owns/publishes; sky-extras read raining/rainIntensity01/rainbow.
anyCtx.weather = { raining: false, rainIntensity01: 0, rainbow: false }
// rainPass — the windshield-rain post pass; Weather drives uIntensity/uSpeed each frame.
anyCtx.rainPass = composer.rainPass

// --- Game + system registration ---------------------------------------------
// Order: planet-water/lighting/sky/celestial first (backdrop + the light rig the
// sky systems drive), then world/scenery/landmarks/npc, then gameplay
// (progression → boost → collectibles → vehicles → paintball → trails → quests),
// then portals + hud + audio + multiplayer last.
const game = new Game(ctx)
game.add(
  // ── backdrop & light rig ──
  createPlanetWaterSystem(planet), // animates the planet's inner water shell
  createLightingSystem(), // OWNS the 3-light rig — must precede Sky/Celestial/Portals
  createSkySystem(), // discovers + drives the dir/hemi lights, owns fog/clear colour
  createCelestialSystem(), // aurora / lanterns / meteors / god rays
  createWeatherSystem(), // rain overlay + schedule; publishes (ctx as any).weather
  createSkyExtrasSystem(), // moon + rainbow; reads (ctx as any).sky and .weather

  // ── regions: publishes (ctx as any).regions; fires 'enterRegion' on crossing ──
  createRegionSystem(regions),

  // ── static world & living world ──
  createScenerySystem(), // trees / rocks / bushes across the globe
  createLandmarksSystem(), // 6 landmarks; publishes (ctx as any).landmarks
  createMonumentSystem(), // world-wonder monuments (GLTF + procedural placeholders) per biome
  createNpcLifeSystem(), // birds/fish/boats/capys + NPC planes → (ctx as any).npcTargets

  // ── progression first so upgrades/progress exist for the systems that read them ──
  createProgressionSystem(),

  // Boost BEFORE Flight-gated consumers: it gates ctx.input.boost when empty and
  // publishes (ctx as any).boostActive that Trails/Hud read this same frame.
  createBoostSystem(),
  createCollectiblesSystem(),
  createVehiclesSystem(), // parents biplane/carpet under ctx.player.obj (planeObj)
  createPaintballSystem(),
  new WeaponSystem(), // Spacebar → pooled glowing projectiles (combat)
  createTrailsSystem(), // reads boostActive (published above)

  // ── quests ──
  createPackageQuestSystem(),
  createSelfieQuestSystem(), // polls (ctx as any).landmarks until Landmarks publishes
  createRaceSystem(),

  // ── world-skin portals after Sky/Celestial so its dome/fog tint wins the frame ──
  createPortalsSystem(),

  // ── HUD + audio + multiplayer last ──
  createHudSystem(), // reads progress / boostActive (both seeded above)
  audioSystem, // drives the engine bed from flight speed
  createMultiplayerSystem(MP_URL) // undefined URL → no-op single player
)

// --- Resize -----------------------------------------------------------------
function onResize() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight, false)
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  composer.setSize(window.innerWidth, window.innerHeight)
}
addEventListener('resize', onResize)

// --- WebGL context loss/restore --------------------------------------------
canvas.addEventListener(
  'webglcontextlost',
  (e) => {
    e.preventDefault() // allow the context to be restored rather than killed
    renderer.setAnimationLoop(null) // pause the loop while the GPU context is gone
  },
  false
)
canvas.addEventListener(
  'webglcontextrestored',
  () => {
    // Re-apply renderer state the GPU forgot, then resume the loop.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(window.innerWidth, window.innerHeight, false)
    renderer.setClearColor((scene.fog as THREE.Fog)?.color ?? PAL.skyHorizon, 1)
    renderer.setAnimationLoop(loop)
  },
  false
)

// --- Loop -------------------------------------------------------------------
// Phase-0 flight feel preserved exactly: clock dt → poll → flight.update →
// systems → chase camera → render. Boost runs inside game.update() (before the
// chase camera), so the gameplay layer settles before the camera reads the frame.
const clock = new THREE.Clock()
function loop() {
  const dt = Math.min(clock.getDelta(), 1 / 30) // clamp: no huge sim jumps after tab throttle/background

  pollKeyboard()
  flight.update(dt, input) // unchanged Phase-0 flight model

  game.update(dt) // all systems: lighting, sky, gameplay, hud, audio, mp …

  updateChaseCamera(camera, planeObj, flight.boosting, dt)

  composer.render()
}
renderer.setAnimationLoop(loop)

// --- Headless debug hook (harmless; lets tooling step the sim deterministically) ---
;(window as any).__sd = {
  game,
  ctx,
  flight,
  input,
  plane: planeObj,
  camera,
  step(n: number, dt = 1 / 60) {
    for (let i = 0; i < n; i++) {
      flight.update(dt, input)
      game.update(dt)
      updateChaseCamera(camera, planeObj, flight.boosting, dt)
    }
    composer.render()
  },
}

// eslint-disable-next-line no-console
console.log('SkyDrift — integrated build — three r' + THREE.REVISION)

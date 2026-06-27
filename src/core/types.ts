import type * as THREE from 'three'
import type { InputState } from '../controls/input'
import type { Flight } from '../plane/flight'

/** The planet every system spawns things on. Smooth sphere has heightAt()=0. */
export interface Planet {
  radius: number
  /** world-scale factor = radius / AUTHORED_RADIUS(100); multiply authored lengths by this */
  scale: number
  /** max terrain displacement above base radius, in world units (= RELIEF · radius) */
  relief: number
  mesh: THREE.Mesh
  /** terrain height above base radius at a unit surface direction (0 for a smooth sphere) */
  heightAt(dir: THREE.Vector3): number
  /** world position on the surface for a unit direction, plus optional extra altitude.
   *  Pass `out` to write into an existing Vector3 (zero-allocation path). */
  surfacePoint(dir: THREE.Vector3, extra?: number, out?: THREE.Vector3): THREE.Vector3
}

export interface Player {
  obj: THREE.Object3D
  flight: Flight
  readonly boosting: boolean
}

// ── Regions: the planet is partitioned into named biome regions (spherical
// Voronoi by capital direction). Built in world/regions.ts; published at
// (ctx as any).regions by the Regions system. (World plan §3.)
export type BiomeKind =
  | 'forest' | 'meadow' | 'jungle' | 'savanna' | 'steppe'
  | 'desert' | 'mesa' | 'badlands'
  | 'snow' | 'tundra' | 'alpine' | 'volcano'
  | 'ocean' | 'archipelago' | 'lake' | 'hub'

export interface RegionDef {
  id: string
  name: string
  /** unit surface direction of the region's centre (assigned at build) */
  capital: THREE.Vector3
  biome: BiomeKind
  /** colour the surface is blended toward inside the region (gives each a hue) */
  tint: THREE.Color
  /** 0..1 how strongly the tint shows at the region core */
  tintAmount: number
  /** -1..1 nudge to mean land height (× planet relief) — desert flat, alpine tall */
  elevationBias: number
  /** angular radius (radians) of this region's live disc for streaming (P3) */
  streamRadius: number
  /** soft cap of tasks this region can host (future task registry) */
  taskSlots: number
}

export interface RegionsApi {
  defs: RegionDef[]
  /** the region containing a unit surface direction (nearest capital) */
  regionAt(dir: THREE.Vector3): RegionDef
  /** the region the player is currently in */
  current: RegionDef
  /** current + streamed-in neighbours (P3); for now == [current] */
  liveSet: RegionDef[]
  isLive(id: string): boolean
  /** subscribe to region-entry; returns an unsubscribe fn */
  onEnter(cb: (r: RegionDef) => void): () => void
}

export type EventName =
  | 'collect'
  | 'levelup'
  | 'boost'
  | 'crash'
  | 'questStart'
  | 'questProgress'
  | 'questComplete'
  | 'vehicleUnlock'
  | 'enterWorld'
  | 'enterRegion'
  | 'fire'

export interface EventBus {
  on(type: EventName, cb: (payload?: any) => void): () => void
  emit(type: EventName, payload?: any): void
}

export interface AudioBus {
  play(name: string, opts?: { volume?: number; rate?: number }): void
  /** drive a continuous engine sound from normalized speed [0..1] */
  setEngine?(speed01: number): void
  /** drive the sustained storm-rain bed from normalized intensity [0..1] */
  setStorm?(intensity01: number): void
  unlock?(): void
}

export interface HudBus {
  /** fixed full-screen overlay root; systems append widgets (respects safe-area via CSS) */
  root: HTMLElement
  toast(msg: string, ms?: number): void
}

/** Passed to every GameSystem.init/update. The shared world. */
export interface GameContext {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  planet: Planet
  player: Player
  input: InputState
  audio: AudioBus
  hud: HudBus
  events: EventBus
  /** seeded deterministic RNG in [0,1) */
  rand(): number
  /** seconds since game start */
  elapsed(): number
}

/** Every gameplay/visual feature is a GameSystem. init() once, update() per frame. */
export interface GameSystem {
  name: string
  init(ctx: GameContext): void
  update(dt: number, ctx: GameContext): void
  dispose?(): void
}

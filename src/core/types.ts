import type * as THREE from 'three'
import type { InputState } from '../controls/input'
import type { Flight } from '../plane/flight'

/** The planet every system spawns things on. Smooth sphere has heightAt()=0. */
export interface Planet {
  radius: number
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
  | 'fire'

export interface EventBus {
  on(type: EventName, cb: (payload?: any) => void): () => void
  emit(type: EventName, payload?: any): void
}

export interface AudioBus {
  play(name: string, opts?: { volume?: number; rate?: number }): void
  /** drive a continuous engine sound from normalized speed [0..1] */
  setEngine?(speed01: number): void
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

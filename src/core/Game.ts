import type { GameContext, GameSystem } from './types'

/** Holds the GameContext + a registry of systems; init on add, update each frame. */
export class Game {
  readonly ctx: GameContext
  private systems: GameSystem[] = []

  constructor(ctx: GameContext) {
    this.ctx = ctx
  }

  add(...s: GameSystem[]): this {
    for (const sys of s) {
      try {
        sys.init(this.ctx)
        this.systems.push(sys)
      } catch (e) {
        console.error('[Game] system init failed:', sys.name, e)
      }
    }
    return this
  }

  update(dt: number): void {
    for (const s of this.systems) {
      try {
        s.update(dt, this.ctx)
      } catch (e) {
        console.error('[Game] system update failed:', s.name, e)
      }
    }
  }

  get(name: string): GameSystem | undefined {
    return this.systems.find((s) => s.name === name)
  }
}

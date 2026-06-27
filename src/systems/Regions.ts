import * as THREE from 'three'
import type { GameContext, GameSystem, RegionDef, RegionsApi } from '../core/types'
import { nearestRegion } from '../world/regions'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Regions system
//
// Tracks which biome region the player is in and publishes the regions contract
// at (ctx as any).regions for content systems (Scenery/Landmarks/Tasks) and the
// world map to read. On crossing into a new region it fires 'enterRegion' and
// toasts the region name. Registered EARLY (after Sky, before Scenery) so other
// systems can read ctx.regions in their own init().
//
// liveSet is just [current] for now; P3 expands it to current + streamed-in
// neighbours and drives the scenery/terrain/task streaming off it.
//
// Budget: an O(16) nearest-capital dot scan throttled to ~5Hz; zero per-frame
// allocation (one reused temp). (World plan §3.)
// ─────────────────────────────────────────────────────────────────────────────

const SCAN_INTERVAL = 0.2 // seconds between region scans (~5Hz)

export function createRegionSystem(defs: RegionDef[]): GameSystem {
  const _dir = new THREE.Vector3()
  let current: RegionDef = defs[0]
  let scan = 0
  const enterCbs: ((r: RegionDef) => void)[] = []

  const api: RegionsApi = {
    defs,
    regionAt: (dir) => nearestRegion(defs, dir),
    current,
    liveSet: [current],
    isLive: (id) => api.liveSet.some((r) => r.id === id),
    onEnter: (cb) => {
      enterCbs.push(cb)
      return () => {
        const i = enterCbs.indexOf(cb)
        if (i >= 0) enterCbs.splice(i, 1)
      }
    },
  }

  return {
    name: 'regions',

    init(ctx: GameContext) {
      _dir.copy(ctx.player.obj.position).normalize()
      current = nearestRegion(defs, _dir)
      api.current = current
      api.liveSet = [current]
      ;(ctx as any).regions = api
    },

    update(dt: number, ctx: GameContext) {
      scan += dt
      if (scan < SCAN_INTERVAL) return
      scan = 0
      _dir.copy(ctx.player.obj.position).normalize()
      const r = nearestRegion(defs, _dir)
      if (r.id !== current.id) {
        current = r
        api.current = r
        api.liveSet = [r] // P3: current + streamed neighbours
        ctx.events.emit('enterRegion', { id: r.id, name: r.name })
        ctx.hud.toast('Entering ' + r.name)
        for (let i = 0; i < enterCbs.length; i++) enterCbs[i](r)
      }
    },
  }
}

import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Crust
//
// A second sphere layered just above the planet's surface — the "crust". A clean
// blue shell that wraps the globe (the green core sits beneath it). Placed
// structures still rise up through it. Tune CRUST_OFFSET / CRUST_COLOR below.
// ─────────────────────────────────────────────────────────────────────────────

const CRUST_OFFSET = 0 // sit at the EXACT surface radius — same level as placed items
const CRUST_COLOR = 0x3f86d6 // blue

export function createCrustSystem(): GameSystem {
  let crust: THREE.Mesh | null = null

  return {
    name: 'crust',
    init(ctx: GameContext) {
      const r = ctx.planet.radius + CRUST_OFFSET
      // High-segment UV sphere: every vertex sits at exactly r (unlike a low-detail
      // icosphere, whose flat facets sag inward and let the green core poke through).
      const geo = new THREE.SphereGeometry(r, 160, 96)
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHex(CRUST_COLOR, THREE.SRGBColorSpace),
        roughness: 0.82,
        metalness: 0,
      })
      crust = new THREE.Mesh(geo, mat)
      crust.name = 'planet-crust'
      ctx.scene.add(crust)
    },
    update() {
      /* static shell — nothing to animate */
    },
    dispose() {
      if (crust) {
        crust.parent?.remove(crust)
        crust.geometry.dispose()
        ;(crust.material as THREE.Material).dispose()
      }
      crust = null
    },
  }
}

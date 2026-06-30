import { WORLD_SCALE } from './WorldConfig'

// ─────────────────────────────────────────────────────────────────────────────
// Sites — a shared, deterministic set of surface "regions" spread evenly over the
// globe (Fibonacci sphere). The Landscape system builds a landmass + coast +
// vegetation at each; the Structures system drops settlements/landmarks on the
// town sites. One source of truth so land and buildings line up.
// ─────────────────────────────────────────────────────────────────────────────

export type Biome = 'forest' | 'meadow' | 'desert' | 'snow'

export interface Site {
  /** unit surface direction of the region centre */
  dir: [number, number, number]
  biome: Biome
  /** landmass radius in world units */
  radius: number
  /** a town/settlement is built here (Structures) */
  hasTown: boolean
  name: string
}

const N = 16
const GOLDEN = Math.PI * (3 - Math.sqrt(5))
const BIOMES: Biome[] = ['forest', 'meadow', 'desert', 'snow']
const NAMES = [
  'Verdant Vale', 'Emerald Meadow', 'Golden Dunes', 'Frostcap Reach',
  'Pinewood', 'Sunmeadow', 'Amber Flats', 'Snowcrest',
  'Mossgrove', 'Greenhollow', 'Dustreach', 'Glacier End',
  'Fernwood', 'Larkfield', 'Sandhaven', 'Winterhold',
]

/** Dome height of each landmass above the CORE shell (world units). Must exceed
 *  the core→crust gap (FLAT_CORE_GAP=6) so islands emerge above the blue crust.
 *  Shared so Structures can seat towns on the hilltop. */
export const LAND_HEIGHT = 14.3

export const SITES: Site[] = Array.from({ length: N }, (_, i) => {
  const y = 1 - ((i + 0.5) / N) * 2 // -1..1, evenly spaced in latitude
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  const th = GOLDEN * i
  const dir: [number, number, number] = [Math.cos(th) * r, y, Math.sin(th) * r]
  return {
    dir,
    biome: BIOMES[i % BIOMES.length],
    radius: (6.5 + (i % 4) * 2.6) * WORLD_SCALE, // ~42..91 world units (toned-down +30%)
    hasTown: i % 3 === 0,
    name: NAMES[i] ?? `Region ${i + 1}`,
  }
})

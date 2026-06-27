// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — WorldConfig: the SINGLE knob for world size.
//
// Change PLANET_RADIUS to resize the entire world. Every length-like constant
// (altitudes, camera distances, fog, speeds, content spawn bands) derives from
// WORLD_SCALE, so flight feel and visual proportions stay invariant at any size;
// only rates/angles (turn rates, damping, FOV) are radius-independent and fixed.
// See the world plan §1.
// ─────────────────────────────────────────────────────────────────────────────

/** Radius all gameplay constants were originally hand-tuned against. */
export const AUTHORED_RADIUS = 100

/** ← THE KNOB. The actual world radius. */
export const PLANET_RADIUS = 640

/** Length scale: multiply any authored (radius-100) world length by this. = 6.4 */
export const WORLD_SCALE = PLANET_RADIUS / AUTHORED_RADIUS

/** Scale an authored (radius-100) world length to the current world size. */
export const len = (authored: number): number => authored * WORLD_SCALE

// Draw distance scales with the world, but the sky dome is decoupled from a pure
// ×S (which would be a vast, mostly-empty sphere): it only needs to exceed the
// fog far distance and sit inside the camera far plane. (Plan §1.)
const FOG_FAR_DAY = 340 * WORLD_SCALE // mirrors Sky.ts day fog far
/** Sky + portal dome shell radius (recentred on the camera each frame). */
export const DOME_RADIUS = Math.max(1200, FOG_FAR_DAY * 1.2)
/** Camera far plane — just beyond the dome so the dome never clips. */
export const CAMERA_FAR = DOME_RADIUS + 200

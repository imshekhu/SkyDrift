import * as THREE from 'three'

// Single source of truth for color — "Cozy Pastel Dusk".
// Author all hex as sRGB so tone mapping / color management behaves.
const c = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)

export const PAL = {
  skyTop: c(0x5a8fd6),
  skyHorizon: c(0xbfe3f2),
  sun: c(0xfff2d6),

  planet: c(0x6abf69),
  tree: c(0x3f8f55),

  // The plane is the ONLY warm coral object in the world — the eye snaps to it.
  planeBody: c(0xff6b5e),
  planeWing: c(0xffd166),

  gem: c(0x7fefff),
}

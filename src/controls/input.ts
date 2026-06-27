// Input bus: every control source (keyboard now; touch/tilt later) fills this same
// shape, so the flight model in plane/flight.ts is input-source-agnostic.
//
// CONTROL SCHEMA (action loop):
//   W / S        throttle up / down   (accelerate / decelerate — a real throttle lever)
//   A / D        bank left / right    (banking CARVES the turn)
//   Arrow Up     climb                (damped-spring climb; release → settle to cruise)
//   Spacebar     fire weapon          (held → auto-fire at the weapon's cadence)
export interface InputState {
  throttle: number // -1..1 — W = +1 (accelerate), S = -1 (decelerate); a RATE on the lever
  roll: number // -1..1 — A = -1 (bank left), D = +1 (bank right)
  climb: number // 0..1  — Arrow Up held → the damped-spring climb
  firing: boolean // Spacebar held → fire the weapon
  boost: boolean // derived by Flight from high throttle; the Boost system reads it for FX
}

export const input: InputState = { throttle: 0, roll: 0, climb: 0, firing: false, boost: false }

const keys: Record<string, boolean> = {}

// Keys we own — preventDefault so the page never scrolls / space-jumps under the game.
const OWNED = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

export function initKeyboard() {
  addEventListener('keydown', (e) => {
    keys[e.code] = true
    if (OWNED.has(e.code)) e.preventDefault()
  })
  addEventListener('keyup', (e) => {
    keys[e.code] = false
  })
}

export function pollKeyboard() {
  let throttle = 0
  let roll = 0
  let climb = 0
  if (keys['KeyW']) throttle += 1 // accelerate
  if (keys['KeyS']) throttle -= 1 // decelerate
  if (keys['KeyA'] || keys['ArrowLeft']) roll -= 1 // bank left
  if (keys['KeyD'] || keys['ArrowRight']) roll += 1 // bank right
  if (keys['ArrowUp']) climb = 1 // damped-spring climb
  input.throttle = throttle
  input.roll = roll
  input.climb = climb
  input.firing = !!keys['Space'] // fire weapon (auto-fire while held)
  // input.boost is owned by Flight (derived from throttle) — not set here.
}

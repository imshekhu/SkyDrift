// Input bus: every control source (keyboard now; touch/tilt later) fills this same
// shape, so the flight model in plane/flight.ts is input-source-agnostic.
export interface InputState {
  pitch: number // -1..1  (climb +, dive -)
  yaw: number // -1..1  (rudder)
  roll: number // -1..1  (bank; bank carves the turn)
  boost: boolean
  rollMove: boolean // one-shot: trigger a barrel roll
}

export const input: InputState = { pitch: 0, yaw: 0, roll: 0, boost: false, rollMove: false }

const keys: Record<string, boolean> = {}

export function initKeyboard() {
  addEventListener('keydown', (e) => {
    keys[e.code] = true
    if (e.code === 'Space') input.rollMove = true
  })
  addEventListener('keyup', (e) => {
    keys[e.code] = false
  })
}

export function pollKeyboard() {
  let pitch = 0
  let yaw = 0
  let roll = 0
  if (keys['KeyW'] || keys['ArrowUp']) pitch += 1
  if (keys['KeyS'] || keys['ArrowDown']) pitch -= 1
  if (keys['KeyA'] || keys['ArrowLeft']) roll -= 1
  if (keys['KeyD'] || keys['ArrowRight']) roll += 1
  if (keys['KeyQ']) yaw += 1
  if (keys['KeyE']) yaw -= 1
  input.pitch = pitch
  input.yaw = yaw
  input.roll = roll
  input.boost = !!(keys['ShiftLeft'] || keys['ShiftRight'])
}

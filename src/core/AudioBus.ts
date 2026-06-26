import type { AudioBus } from './types'

/** No-op audio until the real audio system replaces ctx.audio. */
export function createNullAudio(): AudioBus {
  return { play() {}, setEngine() {}, unlock() {} }
}

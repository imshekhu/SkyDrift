import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Windshield rain (screen-space, refractive)
//
// A single full-screen ShaderPass that simulates rain hitting the canopy/lens:
// procedural drops that TRICKLE downward (faster the faster you fly), each acting
// as a tiny lens that REFRACTS the rendered scene (UV displacement toward each
// drop's centre), plus a glassy rim highlight and a faint storm "gloom" desat.
// The whole effect fades by uIntensity, and early-outs to a pure copy when dry,
// so it costs ~nothing outside a storm.
//
// Owned by the EffectComposer (added LAST, so it refracts the FINAL tonemapped
// image). Driven each frame by the Weather system via the published uniforms:
//   uIntensity (0..1 rain strength)  ·  uSpeed (0..1 plane speed → trickle rate)
// uTime + uAspect are maintained by the composer wrapper (Composer.ts).
//
// Budget: 2 drop-layer evaluations per pixel + one extra tDiffuse tap; no scene
// re-render, no render-target round-trip beyond the pass's own read.
// ─────────────────────────────────────────────────────────────────────────────

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform float uTime;
  uniform float uIntensity;
  uniform float uSpeed;
  uniform vec2 uAspect; // (aspect, 1.0) — keeps drops round at any viewport
  varying vec2 vUv;

  float N(float t) { return fract(sin(t * 12345.564) * 7658.76); }
  float saw(float b, float t) { return smoothstep(0.0, b, t) * smoothstep(1.0, b, t); }

  // One layer of trickling drops on glass.
  // Returns vec3(refractOffset.xy, brightness): the offset points from a drop's
  // centre to this fragment, so sampling tDiffuse at (uv - offset) magnifies the
  // scene through the drop like a little lens.
  vec3 dropLayer(vec2 uv, float t) {
    vec2 UV = uv;
    uv.y += t * 0.75;                 // global downward trickle
    vec2 a = vec2(6.0, 1.0);          // tall cells → vertical streaks
    vec2 grid = a * 2.0;
    vec2 id = floor(uv * grid);
    uv.y += N(id.x);                  // stagger columns so streaks don't align
    id = floor(uv * grid);
    vec3 n = vec3(N(id.x), N(id.y), N(id.x + id.y));
    vec2 st = fract(uv * grid) - vec2(0.5, 0.0);
    float x = (n.x - 0.5) * 0.7;
    float yw = UV.y * 20.0;
    x += sin(yw + sin(yw)) * (0.5 - abs(x)) * (n.z - 0.5) * 0.5; // wobble as it slides
    float ti = fract(t + n.z);
    float yy = (saw(0.85, ti) - 0.5) * 0.9 + 0.5;               // the falling drop's y
    vec2 p = vec2(x, yy);
    float d = length((st - p) * a.yx);
    float mainDrop = smoothstep(0.4, 0.0, d);
    // small static droplets clinging in the streak above the falling drop
    float r = sqrt(smoothstep(1.0, yy, st.y));
    float cd = abs(st.x - x);
    float trail = smoothstep(0.23 * r, 0.15 * r * r, cd)
                * smoothstep(-0.02, 0.02, st.y - yy) * r * r;
    float yr = fract(UV.y * 10.0) + (st.y - 0.5);
    float droplets = smoothstep(0.3, 0.0, length(st - vec2(x, yr))) * trail;
    float m = mainDrop + droplets;
    return vec3((st - p) * m, m);
  }

  void main() {
    vec2 uv = vUv;
    float inten = uIntensity;
    // bone-dry: a straight copy (and the GPU skips the heavy branch)
    if (inten < 0.01) { gl_FragColor = texture2D(tDiffuse, uv); return; }

    vec2 duv = (vUv - 0.5) * uAspect + 0.5;     // aspect-correct → round drops
    float t = uTime * (0.35 + 0.9 * uSpeed);    // trickle accelerates with speed
    vec3 c1 = dropLayer(duv * 1.15, t);
    vec3 c2 = dropLayer(duv * 1.90 + 7.3, t * 1.2 + 3.1);

    vec2 disp = (c1.xy + c2.xy * 0.7) * 0.16 * inten; // refraction displacement
    float drops = clamp(c1.z + c2.z * 0.7, 0.0, 1.0);

    vec3 col = texture2D(tDiffuse, uv - disp).rgb;
    col += drops * drops * 0.10 * inten;              // glassy rim/bead highlight
    // storm gloom — a touch of desaturation across the whole pane in heavy rain
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(l) * 0.92, 0.12 * inten);

    gl_FragColor = vec4(col, 1.0);
  }
`

/** Build the windshield-rain ShaderPass. `width`/`height` seed the aspect uniform. */
export function createWindshieldRainPass(width: number, height: number): ShaderPass {
  const pass = new ShaderPass({
    name: 'WindshieldRain',
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uSpeed: { value: 0 },
      uAspect: { value: new THREE.Vector2(width / Math.max(1, height), 1) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  })
  return pass
}

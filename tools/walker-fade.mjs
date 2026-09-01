const NAME = 'WalkerFade';

const GLSL = `
#ifdef WALKER_FADE
  if (gl_FragCoord.z < walkerFade.z) {
    float wfR = length(gl_FragCoord.xy - walkerCenter);
    float wfF = (1.0 - smoothstep(walkerFade.x, walkerFade.y, wfR)) * walkerFade.w;
    float wfN = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (wfF > wfN) discard;
  }
#endif
`;

const WGSL = `
#ifdef WALKER_FADE
  if (fragmentInputs.position.z < uniforms.walkerFade.z) {
    let wfR: f32 = length(fragmentInputs.position.xy - uniforms.walkerCenter);
    let wfF: f32 = (1.0 - smoothstep(uniforms.walkerFade.x, uniforms.walkerFade.y, wfR)) * uniforms.walkerFade.w;
    let wfN: f32 = fract(52.9829189 * fract(dot(fragmentInputs.position.xy, vec2f(0.06711056, 0.00583715))));
    if (wfF > wfN) { discard; }
  }
#endif
`;

export function walkerFade(BABYLON, meshes) {
  const wgslOf = (lang) => BABYLON.ShaderLanguage && lang === BABYLON.ShaderLanguage.WGSL;

  class WalkerFadePlugin extends BABYLON.MaterialPluginBase {
    constructor(material) {
      super(material, NAME, 200, { WALKER_FADE: true }, true, true);
      this.cx = 0; this.cy = 0;
      this.inner = 0; this.outer = 0; this.depth = 0; this.strength = 0;
    }
    getClassName() { return NAME; }
    prepareDefines(defines) { defines.WALKER_FADE = true; }
    getUniforms(shaderLanguage) {
      const ubo = [
        { name: 'walkerCenter', size: 2, type: 'vec2' },
        { name: 'walkerFade', size: 4, type: 'vec4' },
      ];
      if (wgslOf(shaderLanguage)) return { ubo };
      return {
        ubo,
        fragment: `#ifdef WALKER_FADE
uniform vec2 walkerCenter;
uniform vec4 walkerFade;
#endif`,
      };
    }
    bindForSubMesh(uniformBuffer) {
      uniformBuffer.updateFloat2('walkerCenter', this.cx, this.cy);
      uniformBuffer.updateFloat4('walkerFade', this.inner, this.outer, this.depth, this.strength);
    }
    getCustomCode(shaderType, shaderLanguage) {
      if (shaderType !== 'fragment') return null;
      return { CUSTOM_FRAGMENT_MAIN_BEGIN: wgslOf(shaderLanguage) ? WGSL : GLSL };
    }
  }

  const plugins = meshes.map((m) => new WalkerFadePlugin(m.material));
  return (cx, cy, depth, inner, outer, strength) => {
    for (const p of plugins) {
      p.cx = cx; p.cy = cy; p.depth = depth;
      p.inner = inner; p.outer = outer; p.strength = strength;
    }
  };
}

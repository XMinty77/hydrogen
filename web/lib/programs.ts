import * as twgl from "twgl.js";

/** Replace a discrete uniform with a compile-time constant. The shared GLSL
 * and its arithmetic stay unchanged; dead integrators/derivatives disappear
 * before the driver expands their nested wavefunction evaluations. */
export function specialize(source: string, constants: Record<string, number>): string {
  for (const [name, value] of Object.entries(constants)) {
    source = source.replace(
      new RegExp(`uniform\\s+int\\s+${name}\\s*;`),
      `const int ${name} = ${value};`,
    );
  }
  return source;
}

export interface ProgramSpec {
  name: string;
  constants?: Record<string, number>;
}

const standalone = new Set([
  "axes", "flow_decay", "post_bloom_extract", "post_bloom_blur", "post_composite",
]);

/** Fetch and compile only programs needed by the current frame. A small LRU
 * bounds driver memory when switching between techniques and solver options. */
export class Programs {
  private readonly sources = new Map<string, Promise<string>>();
  private readonly cache = new Map<string, twgl.ProgramInfo>();
  private active = new Map<string, twgl.ProgramInfo>();
  private signature = "";
  private disposed = false;

  constructor(private readonly gl: WebGL2RenderingContext, private readonly base: string) {
    // Enable asynchronous completion polling before the first submission.
    // TWGL also discovers this extension when it starts polling after link.
    gl.getExtension("KHR_parallel_shader_compile");
  }

  private source(file: string) {
    let result = this.sources.get(file);
    if (!result) {
      result = fetch(`${this.base}/${file}`).then((response) => {
        if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
        return response.text();
      });
      this.sources.set(file, result);
    }
    return result;
  }

  /** null means all required programs are already active: no per-frame awaits. */
  prepare(specs: ProgramSpec[]): Promise<void> | null {
    const signature = JSON.stringify(specs);
    if (signature === this.signature) return null;
    return this.load(specs, signature);
  }

  private async load(specs: ProgramSpec[], signature: string) {
    const active = new Map<string, twgl.ProgramInfo>();
    // Fetch independent sources together, but compile one program at a time:
    // several flow solvers compiling together can exhaust driver memory.
    const [vert, prelude, common, particleVert, ...bodies] = await Promise.all([
      this.source("fullscreen.vert"), this.source("prelude.glsl"),
      specs.some((s) => !standalone.has(s.name)) ? this.source("common.glsl") : "",
      specs.some((s) => s.name === "flow_particles") ? this.source("flow_particles.vert") : "",
      ...specs.map((s) => this.source(`${s.name}.frag`)),
    ]);
    for (let i = 0; i < specs.length; i++) {
      if (this.disposed) return;
      const spec = specs[i];
      const key = JSON.stringify(spec);
      let pi = this.cache.get(key);
      if (pi) {
        this.cache.delete(key); // move to most recently used
      } else {
        const src = specialize(prelude + (standalone.has(spec.name) ? "" : common) + bodies[i], spec.constants ?? {});
        pi = await twgl.createProgramInfoAsync(this.gl, [
          spec.name === "flow_particles" ? particleVert : vert, src,
        ]);
        // TWGL retains attached shaders on successful links. They are no
        // longer needed after introspection, including on disposal mid-compile.
        for (const shader of this.gl.getAttachedShaders(pi.program) ?? []) {
          this.gl.detachShader(pi.program, shader);
          this.gl.deleteShader(shader);
        }
        if (this.disposed) {
          this.gl.deleteProgram(pi.program);
          return;
        }
      }
      this.cache.set(key, pi);
      active.set(spec.name, pi);
    }
    this.active = active;
    this.signature = signature;
    const protectedPrograms = new Set(active.values());
    for (const [key, pi] of this.cache) {
      if (this.cache.size <= 16) break;
      if (protectedPrograms.has(pi)) continue;
      this.gl.deleteProgram(pi.program);
      this.cache.delete(key);
    }
  }

  get(name: string): twgl.ProgramInfo {
    const pi = this.active.get(name);
    if (!pi) throw new Error(`program ${name} was not prepared`);
    return pi;
  }

  dispose() {
    this.disposed = true;
    for (const pi of this.cache.values()) this.gl.deleteProgram(pi.program);
    this.cache.clear();
    this.active.clear();
    this.sources.clear();
  }
}

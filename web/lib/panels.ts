// =============================================================================
// panels.ts — the custom overlay panels: superposition editor, palette editor,
// keybind help. Plain DOM (no React): the whole viewer already lives outside
// React's render cycle, and these panels bind straight to the same mutable
// Params object lil-gui does. Styling lives in app/globals.css (.hy-*).
// =============================================================================

import {
  hexToSrgb,
  oklabToOklch,
  oklabToSrgb,
  oklchToOklab,
  srgbToHex,
  srgbToOklab,
  type Rgb,
} from "./color";
import type { Params, RampStop } from "./params";
import type { Ramp } from "./palettes";
import {
  beatPeriod,
  clampTerm,
  MAX_TERMS,
  SUPER_PRESETS,
  type SuperTerm,
} from "./superposition";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

// ---------------------------------------------------------------------------
// Superposition editor.
// ---------------------------------------------------------------------------

export interface TermsPanelOptions {
  params: Params;
  nMax: number;
  /** Called after any edit (terms, normalize, preset). `structural` = the term
   * list itself changed (new textures / normalization), not just a value. */
  onChange: () => void;
  /** A preset may switch real/complex mode and suggest a time scale. */
  onPreset: (mode: "real" | "complex", timeScale: number) => void;
}

export class TermsPanel {
  readonly root: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly opts: TermsPanelOptions;

  constructor(opts: TermsPanelOptions) {
    this.opts = opts;
    this.root = el("div", "hy-panel hy-terms");
    this.root.style.display = "none";

    const head = el("div", "hy-panel-head");
    head.append(el("span", "hy-panel-title", "superposition"));
    head.append(button("×", "hy-close", () => this.hide()));
    this.root.append(head);

    const sub = el("div", "hy-panel-sub");
    sub.textContent = "ψ = Σ cₖ |n,l,m⟩ — edit terms, amplitudes and phases";
    this.root.append(sub);

    this.list = el("div", "hy-term-list");
    this.root.append(this.list);

    const foot = el("div", "hy-panel-foot");
    foot.append(
      button("+ add term", "hy-btn", () => {
        const p = this.opts.params;
        if (p.terms.length >= MAX_TERMS) return;
        const last = p.terms[p.terms.length - 1];
        p.terms.push(
          last ? { ...last } : { n: p.n, l: p.l, m: p.m, amp: 1, phaseDeg: 0 },
        );
        this.render();
        this.opts.onChange();
      }),
    );

    const preset = el("select", "hy-select") as HTMLSelectElement;
    preset.append(new Option("presets…", "", true, true));
    SUPER_PRESETS.forEach((pr, i) => preset.append(new Option(pr.name, `${i}`)));
    preset.addEventListener("change", () => {
      if (preset.value === "") return;
      const pr = SUPER_PRESETS[+preset.value];
      const p = this.opts.params;
      p.terms = pr.terms.map((t) => clampTerm({ ...t }, this.opts.nMax));
      p.superNormalize = true;
      this.opts.onPreset(pr.mode, pr.timeScale);
      preset.value = "";
      this.render();
      this.opts.onChange();
    });
    foot.append(preset);

    const normLabel = el("label", "hy-check");
    const norm = el("input") as HTMLInputElement;
    norm.type = "checkbox";
    norm.checked = opts.params.superNormalize;
    norm.addEventListener("change", () => {
      opts.params.superNormalize = norm.checked;
      opts.onChange();
    });
    normLabel.append(norm, document.createTextNode("normalize"));
    foot.append(normLabel);

    foot.append(
      button("clear", "hy-btn hy-btn-dim", () => {
        this.opts.params.terms = [];
        this.render();
        this.opts.onChange();
      }),
    );
    this.root.append(foot);

    this.hint = el("div", "hy-panel-hint");
    this.root.append(this.hint);

    document.body.append(this.root);
  }

  get visible(): boolean {
    return this.root.style.display !== "none";
  }

  show() {
    // Opening with no terms seeds the current single state as term 1, so the
    // editor always starts from what is on screen.
    const p = this.opts.params;
    if (p.terms.length === 0) {
      p.terms = [{ n: p.n, l: p.l, m: p.m, amp: 1, phaseDeg: 0 }];
      this.opts.onChange();
    }
    this.render();
    this.root.style.display = "";
  }

  hide() {
    // Collapse a lone (or empty) term list back to the single-state path on
    // close. Opening the editor seeds the current state as term 1 (so it always
    // starts from what's on screen), but leaving that 1-term "superposition"
    // in place would silently shadow the main n,l,m controls — the render uses
    // the term list whenever it is non-empty. A real superposition (≥2 terms)
    // is untouched; a single term is equivalent to the plain state anyway
    // (amplitude/global-phase are absorbed by normalization), so copy its
    // quantum numbers back and clear the list.
    const p = this.opts.params;
    if (p.terms.length === 1) {
      p.n = p.terms[0].n;
      p.l = p.terms[0].l;
      p.m = p.terms[0].m;
      p.terms = [];
      this.opts.onChange();
    }
    this.root.style.display = "none";
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  /** Rebuild the term rows from params (called on show and after edits). */
  render() {
    const p = this.opts.params;
    this.list.textContent = "";

    const header = el("div", "hy-term-row hy-term-header");
    for (const h of ["", "n", "l", "m", "amplitude", "phase °", ""])
      header.append(el("span", "hy-term-cell", h));
    this.list.append(header);

    p.terms.forEach((t, i) => this.list.append(this.termRow(t, i)));

    const beat = beatPeriod(p.terms);
    this.hint.textContent =
      p.terms.length === 0
        ? "no terms — single-state view"
        : beat === null
          ? "all terms share one energy — stationary (phases never drift)"
          : `slowest beat ≈ ${beat.toFixed(0)} au — enable time (Space) to watch it`;
  }

  private termRow(t: SuperTerm, i: number): HTMLDivElement {
    const p = this.opts.params;
    const row = el("div", "hy-term-row");
    row.append(el("span", "hy-term-cell hy-term-dot", `${i + 1}`));

    const qn = (get: () => number, set: (v: number) => void, min: number, max: number) => {
      const inp = el("input", "hy-num") as HTMLInputElement;
      inp.type = "number";
      inp.min = `${min}`;
      inp.max = `${max}`;
      inp.step = "1";
      inp.value = `${get()}`;
      inp.addEventListener("change", () => {
        set(Number.isFinite(+inp.value) ? +inp.value : get());
        p.terms[i] = clampTerm(p.terms[i], this.opts.nMax);
        this.render();
        this.opts.onChange();
      });
      return inp;
    };
    row.append(qn(() => t.n, (v) => (t.n = v), 1, this.opts.nMax));
    row.append(qn(() => t.l, (v) => (t.l = v), 0, t.n - 1));
    row.append(qn(() => t.m, (v) => (t.m = v), -t.l, t.l));

    const slider = (
      value: number,
      min: number,
      max: number,
      step: number,
      digits: number,
      set: (v: number) => void,
    ) => {
      const wrap = el("span", "hy-term-cell hy-slider-wrap");
      const s = el("input", "hy-slider") as HTMLInputElement;
      s.type = "range";
      s.min = `${min}`;
      s.max = `${max}`;
      s.step = `${step}`;
      s.value = `${value}`;
      const out = el("span", "hy-slider-val", value.toFixed(digits));
      s.addEventListener("input", () => {
        set(+s.value);
        out.textContent = (+s.value).toFixed(digits);
        this.opts.onChange();
      });
      wrap.append(s, out);
      return wrap;
    };
    row.append(slider(t.amp, 0, 1.5, 0.01, 2, (v) => (t.amp = v)));
    row.append(slider(t.phaseDeg, -180, 180, 1, 0, (v) => (t.phaseDeg = v)));

    row.append(
      button("×", "hy-close hy-term-cell", () => {
        p.terms.splice(i, 1);
        this.render();
        this.opts.onChange();
      }),
    );
    return row;
  }
}

// ---------------------------------------------------------------------------
// Palette (ramp) editor.
// ---------------------------------------------------------------------------

/** Build a Ramp (srgb + oklab stop lists) from editable hex stops — the same
 * dual representation palettes.json ships, so the renderer treats the custom
 * ramp exactly like a baked one. */
export function rampFromStops(stops: RampStop[]): Ramp {
  const srgb: number[][] = [];
  const oklab: number[][] = [];
  const positions: number[] = [];
  for (const s of stops) {
    const rgb = hexToSrgb(s.hex) ?? [0, 0, 0];
    positions.push(s.pos);
    srgb.push(rgb as number[]);
    oklab.push(srgbToOklab(rgb as Rgb) as number[]);
  }
  return { positions, srgb, oklab };
}

export interface PalettePanelOptions {
  params: Params;
  /** Named ramps from palettes.json — the "start from" seeds. */
  ramps: Record<string, Ramp>;
  /** Phase-wheel palette defaults (shown when the sliders are untouched). */
  phaseDefaults: { L: number; C: number; h0Deg: number };
  onChange: () => void;
  /** Produce the current shareable URL (for the copy button). */
  currentUrl: () => string;
}

export class PalettePanel {
  readonly root: HTMLDivElement;
  private readonly opts: PalettePanelOptions;
  private readonly bar: HTMLCanvasElement;
  private readonly handles: HTMLDivElement;
  private readonly stopList: HTMLDivElement;
  private readonly note: HTMLDivElement;

  constructor(opts: PalettePanelOptions) {
    this.opts = opts;
    this.root = el("div", "hy-panel hy-palette");
    this.root.style.display = "none";

    const head = el("div", "hy-panel-head");
    head.append(el("span", "hy-panel-title", "palette editor"));
    head.append(button("×", "hy-close", () => this.hide()));
    this.root.append(head);

    const sub = el("div", "hy-panel-sub");
    sub.textContent = "edits select the “custom” ramp; drag handles, click the bar to add a stop";
    this.root.append(sub);

    // Gradient preview: sampled through the true interpolation (OKLab or
    // sRGB per the rampSpace setting), not a CSS approximation.
    const barWrap = el("div", "hy-bar-wrap");
    this.bar = el("canvas", "hy-bar") as HTMLCanvasElement;
    this.bar.width = 512;
    this.bar.height = 1;
    this.bar.addEventListener("pointerdown", (e) => this.addStopAt(e));
    this.handles = el("div", "hy-handles");
    barWrap.append(this.bar, this.handles);
    this.root.append(barWrap);

    this.stopList = el("div", "hy-stop-list");
    this.root.append(this.stopList);

    const seedRow = el("div", "hy-panel-foot");
    seedRow.append(el("span", "hy-label", "start from"));
    const seed = el("select", "hy-select") as HTMLSelectElement;
    seed.append(new Option("choose…", "", true, true));
    for (const name of Object.keys(opts.ramps)) seed.append(new Option(name, name));
    seed.addEventListener("change", () => {
      const ramp = opts.ramps[seed.value];
      if (!ramp) return;
      opts.params.rampStops = ramp.positions.map((pos, i) => ({
        pos,
        hex: srgbToHex(ramp.srgb[i] as Rgb),
      }));
      seed.value = "";
      this.applyCustom();
    });
    seedRow.append(seed);
    this.root.append(seedRow);

    // Phase-wheel section (the "each color mode" part of the request; the
    // ramp above serves ramp+signed, these sliders serve phase coloring).
    const phaseHead = el("div", "hy-panel-sub hy-phase-head", "phase wheel (complex mode)");
    this.root.append(phaseHead);
    const phaseRow = el("div", "hy-phase-grid");
    const phaseSlider = (
      label: string,
      min: number,
      max: number,
      step: number,
      get: () => number,
      set: (v: number) => void,
      digits: number,
    ) => {
      phaseRow.append(el("span", "hy-label", label));
      const s = el("input", "hy-slider") as HTMLInputElement;
      s.type = "range";
      s.min = `${min}`;
      s.max = `${max}`;
      s.step = `${step}`;
      s.value = `${get()}`;
      const out = el("span", "hy-slider-val", get().toFixed(digits));
      s.addEventListener("input", () => {
        set(+s.value);
        out.textContent = (+s.value).toFixed(digits);
        this.opts.onChange();
      });
      phaseRow.append(s, out);
    };
    const d = opts.phaseDefaults;
    const p = opts.params;
    phaseSlider("lightness", 0.3, 0.95, 0.005,
      () => (Number.isNaN(p.phaseL) ? d.L : p.phaseL), (v) => (p.phaseL = v), 3);
    phaseSlider("chroma", 0, 0.3, 0.002,
      () => (Number.isNaN(p.phaseC) ? d.C : p.phaseC), (v) => (p.phaseC = v), 3);
    phaseSlider("hue zero °", -180, 180, 1,
      () => (Number.isNaN(p.phaseH0Deg) ? d.h0Deg : p.phaseH0Deg),
      (v) => (p.phaseH0Deg = v), 0);
    this.root.append(phaseRow);

    const foot = el("div", "hy-panel-foot");
    foot.append(
      button("copy URL", "hy-btn", () => {
        navigator.clipboard?.writeText(this.opts.currentUrl());
        this.flash("URL copied");
      }),
      button("copy JSON", "hy-btn", () => {
        const ramp = rampFromStops(this.opts.params.rampStops);
        navigator.clipboard?.writeText(JSON.stringify({ custom: ramp }, null, 2));
        this.flash("palettes.json snippet copied");
      }),
    );
    this.root.append(foot);

    this.note = el("div", "hy-panel-hint");
    this.root.append(this.note);

    document.body.append(this.root);
  }

  get visible(): boolean {
    return this.root.style.display !== "none";
  }

  show() {
    this.render();
    this.root.style.display = "";
  }
  hide() {
    this.root.style.display = "none";
  }
  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  private flash(msg: string) {
    this.note.textContent = msg;
    setTimeout(() => {
      if (this.note.textContent === msg) this.note.textContent = "";
    }, 1600);
  }

  /** Any edit selects the custom ramp and re-renders live. */
  private applyCustom() {
    this.opts.params.ramp = "custom";
    this.render();
    this.opts.onChange();
  }

  private addStopAt(e: PointerEvent) {
    const p = this.opts.params;
    if (p.rampStops.length >= 8) return;
    const rect = this.bar.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ramp = rampFromStops(p.rampStops);
    const rgb = sampleRamp(ramp, pos, p.rampSpace === "srgb");
    p.rampStops.push({ pos, hex: srgbToHex(rgb) });
    p.rampStops.sort((a, b) => a.pos - b.pos);
    this.applyCustom();
  }

  render() {
    const p = this.opts.params;
    const stops = p.rampStops;
    const ramp = rampFromStops(stops);
    const srgbSpace = p.rampSpace === "srgb";

    // Preview bar.
    const ctx = this.bar.getContext("2d")!;
    const img = ctx.createImageData(this.bar.width, 1);
    for (let x = 0; x < this.bar.width; x++) {
      const [r, g, b] = sampleRamp(ramp, x / (this.bar.width - 1), srgbSpace);
      img.data[4 * x] = Math.round(r * 255);
      img.data[4 * x + 1] = Math.round(g * 255);
      img.data[4 * x + 2] = Math.round(b * 255);
      img.data[4 * x + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    // Handles (draggable).
    this.handles.textContent = "";
    stops.forEach((s) => {
      const h = el("div", "hy-handle");
      h.style.left = `${s.pos * 100}%`;
      h.style.background = s.hex;
      h.addEventListener("pointerdown", (down) => {
        down.stopPropagation();
        h.setPointerCapture(down.pointerId);
        const rect = this.bar.getBoundingClientRect();
        const onMove = (mv: PointerEvent) => {
          s.pos = Math.max(0, Math.min(1, (mv.clientX - rect.left) / rect.width));
          h.style.left = `${s.pos * 100}%`;
          this.opts.params.ramp = "custom";
          this.opts.onChange();
          this.renderBarOnly();
        };
        const onUp = () => {
          h.removeEventListener("pointermove", onMove);
          h.removeEventListener("pointerup", onUp);
          stops.sort((a, b) => a.pos - b.pos);
          this.render();
          this.opts.onChange();
        };
        h.addEventListener("pointermove", onMove);
        h.addEventListener("pointerup", onUp);
      });
      this.handles.append(h);
    });

    // Stop rows. Each stop is a card: a top line (sRGB swatch · position ·
    // delete) plus an OKLCH line (perceptual L / C / h sliders) — editing a
    // stop in the same cylindrical space the ramp interpolates through, which
    // is what keeps a hand-tuned palette smooth. The two editors are live-
    // linked through the stop's hex.
    this.stopList.textContent = "";
    stops.forEach((s, i) => {
      const card = el("div", "hy-stop-card");
      const row = el("div", "hy-stop-row");

      const color = el("input", "hy-color") as HTMLInputElement;
      color.type = "color";
      color.value = s.hex;
      color.addEventListener("input", () => {
        s.hex = color.value;
        this.opts.params.ramp = "custom";
        this.opts.onChange();
        this.renderBarOnly();
      });
      color.addEventListener("change", () => this.render()); // resync LCH sliders
      row.append(color);

      const pos = el("input", "hy-slider") as HTMLInputElement;
      pos.type = "range";
      pos.min = "0";
      pos.max = "1";
      pos.step = "0.001";
      pos.value = `${s.pos}`;
      const posVal = el("span", "hy-slider-val", s.pos.toFixed(3));
      pos.addEventListener("input", () => {
        s.pos = +pos.value;
        posVal.textContent = s.pos.toFixed(3);
        this.opts.params.ramp = "custom";
        this.opts.onChange();
        this.renderBarOnly();
      });
      pos.addEventListener("change", () => {
        stops.sort((a, b) => a.pos - b.pos);
        this.render();
        this.opts.onChange();
      });
      row.append(pos);
      row.append(posVal);

      const del = button("×", "hy-close", () => {
        if (stops.length <= 2) return;
        stops.splice(i, 1);
        this.applyCustom();
      });
      if (stops.length <= 2) del.disabled = true;
      row.append(del);
      card.append(row);

      // OKLCH line. lch stays authoritative during a drag (out-of-gamut chroma
      // is clamped only when written to hex, and re-derived on the next full
      // render), so dragging feels continuous.
      const lch = oklabToOklch(srgbToOklab(hexToSrgb(s.hex) ?? [0, 0, 0]));
      const commit = () => {
        s.hex = srgbToHex(oklabToSrgb(oklchToOklab(lch)));
        color.value = s.hex;
        this.opts.params.ramp = "custom";
        this.opts.onChange();
        this.renderBarOnly();
      };
      const lchRow = el("div", "hy-lch-row");
      const slot = (label: string, idx: number, min: number, max: number,
                    step: number, digits: number) => {
        const slotEl = el("span", "hy-lch-slot");
        slotEl.append(el("span", "hy-lch-lab", label));
        const sl = el("input", "hy-slider") as HTMLInputElement;
        sl.type = "range";
        sl.min = `${min}`;
        sl.max = `${max}`;
        sl.step = `${step}`;
        sl.value = `${lch[idx]}`;
        const out = el("span", "hy-lch-val", lch[idx].toFixed(digits));
        sl.addEventListener("input", () => {
          lch[idx] = +sl.value;
          out.textContent = lch[idx].toFixed(digits);
          commit();
        });
        sl.addEventListener("change", () => this.render());
        slotEl.append(sl, out);
        lchRow.append(slotEl);
      };
      slot("L", 0, 0, 1, 0.001, 3);
      slot("C", 1, 0, 0.37, 0.001, 3);
      slot("H", 2, 0, 360, 1, 0);
      card.append(lchRow);

      this.stopList.append(card);
    });
  }

  /** Cheap refresh of the gradient + handle positions during drags. */
  private renderBarOnly() {
    const p = this.opts.params;
    const ramp = rampFromStops(p.rampStops);
    const srgbSpace = p.rampSpace === "srgb";
    const ctx = this.bar.getContext("2d")!;
    const img = ctx.createImageData(this.bar.width, 1);
    for (let x = 0; x < this.bar.width; x++) {
      const [r, g, b] = sampleRamp(ramp, x / (this.bar.width - 1), srgbSpace);
      img.data[4 * x] = Math.round(r * 255);
      img.data[4 * x + 1] = Math.round(g * 255);
      img.data[4 * x + 2] = Math.round(b * 255);
      img.data[4 * x + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
}

/** CPU mirror of the shader's rampStops + color-space handling: piecewise
 * lerp of the stops in OKLab (default) or gamma sRGB, → display sRGB. */
function sampleRamp(ramp: Ramp, t: number, srgbSpace: boolean): Rgb {
  const stops = srgbSpace ? ramp.srgb : ramp.oklab;
  const pos = ramp.positions;
  let c: number[];
  if (t <= pos[0]) c = stops[0];
  else if (t >= pos[pos.length - 1]) c = stops[stops.length - 1];
  else {
    let i = 1;
    while (pos[i] < t) i++;
    const s = (t - pos[i - 1]) / Math.max(pos[i] - pos[i - 1], 1e-6);
    c = stops[i - 1].map((a, k) => a + (stops[i][k] - a) * s);
  }
  return srgbSpace
    ? (c.map((x) => Math.max(0, Math.min(1, x))) as Rgb)
    : oklabToSrgb(c as Rgb);
}

// ---------------------------------------------------------------------------
// Keybind help overlay.
// ---------------------------------------------------------------------------

const KEYBINDS: [string, string][] = [
  ["drag / wheel", "orbit camera · dolly (volume) — rotate plane · zoom (slice)"],
  ["click canvas", "fly mode: capture the mouse (Esc releases)"],
  ["W A S D + E Q", "fly · center-locked: sphere strafe (WS = radius)"],
  ["Shift", "fly boost ×3"],
  ["C", "toggle center-locked fly (always look at the nucleus)"],
  ["Space", "play / pause time evolution"],
  ["R", "reset time to t = 0"],
  ["P", "save a PNG of the current frame (no UI)"],
  ["U", "copy the current view URL"],
  ["G", "show / hide the control panels"],
  ["Esc", "return focus to the canvas (re-enable these keys)"],
  ["H  or  ?", "this help"],
];

export class HelpOverlay {
  readonly root: HTMLDivElement;

  constructor() {
    this.root = el("div", "hy-help-backdrop");
    this.root.style.display = "none";
    const card = el("div", "hy-panel hy-help");
    const head = el("div", "hy-panel-head");
    head.append(el("span", "hy-panel-title", "keyboard controls"));
    head.append(button("×", "hy-close", () => this.hide()));
    card.append(head);
    const grid = el("div", "hy-help-grid");
    for (const [k, desc] of KEYBINDS) {
      grid.append(el("kbd", "hy-kbd", k));
      grid.append(el("span", "hy-help-desc", desc));
    }
    card.append(grid);
    this.root.append(card);
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.hide();
    });
    document.body.append(this.root);
  }

  get visible(): boolean {
    return this.root.style.display !== "none";
  }
  show() {
    this.root.style.display = "";
  }
  hide() {
    this.root.style.display = "none";
  }
  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }
}

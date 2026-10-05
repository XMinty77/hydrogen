import { LOADING_RUNTIME } from "../lib/loading-runtime";

/** Physics-based orbital drawn by a tiny parser-executed inline script.
 * Critical loader CSS is inline; the shared app stylesheet stays separate. */
const styles = `
.loading {
  position: fixed; inset: 0; z-index: 40; background: #000;
  transition: opacity .55s ease;
}
.loading-done { opacity: 0; pointer-events: none; }
.loading-art {
  position: absolute; inset: 0;
}
.loading-orbital {
  position: absolute; left: 50%; top: 45%;
  width: min(48vmin, 430px); aspect-ratio: 1;
  transform: translate(-50%, -50%);
}
.loading-orbital canvas {
  position: absolute; inset: 0; width: 100%; height: 100%;
}
.loading-orbital canvas[hidden], .loading[hidden] { display: none; }
.loading-caption {
  position: absolute; left: 0; right: 0; bottom: 8vh; text-align: center;
  color: #cbd8ed; font: 11px/1.7 ui-monospace, "Cascadia Mono", monospace;
  text-shadow: 0 1px 10px #000d; pointer-events: none;
}
.loading-title {
  color: #f0a832; font-weight: 700; font-size: 13px; letter-spacing: .42em;
  text-indent: .42em; text-transform: uppercase;
}
.loading-state { color: #9fb2cf; letter-spacing: .06em; }
.loading-bar {
  width: min(220px, 45vw); height: 2px; margin: 9px auto 6px;
  background: #cbd8ed29; border-radius: 1px; overflow: hidden;
}
.loading-bar > i {
  display: block; width: 0; height: 100%;
  background: linear-gradient(90deg, #a42e6c, #f98b28, #fffbe0);
  transition: width .25s ease-out;
}
.loading-note { color: #7e8ba3; letter-spacing: .14em; text-transform: uppercase; }
`;

export default function LoadingScreen() {
  return (
    <div id="loading" className="loading" role="status" aria-live="polite">
      <style>{styles}</style>
      <div className="loading-art" aria-hidden="true">
        <div className="loading-orbital">
          <canvas id="loading-worker" width={256} height={256} suppressHydrationWarning />
          <canvas id="loading-first-frame" width={256} height={256} suppressHydrationWarning />
        </div>
      </div>
      <div className="loading-caption">
        <div className="loading-title">hydrogen</div>
        <div className="loading-state">hydrogen orbitals</div>
        <div className="loading-bar"><i id="loading-bar" /></div>
        <div id="loading-note" className="loading-note">starting</div>
      </div>
      <script dangerouslySetInnerHTML={{ __html: LOADING_RUNTIME }} />
    </div>
  );
}

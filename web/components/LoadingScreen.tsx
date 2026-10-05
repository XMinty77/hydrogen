/** Static HTML: visible before the viewer chunk, tables, or GPU are ready. */
export default function LoadingScreen() {
  return (
    <div id="loading" className="loading" role="status" aria-live="polite">
      <div className="loading-art" aria-hidden="true" />
      <img className="loading-orbital" src={`${process.env.PAGES_BASE_PATH ?? ""}/loading-orbital.webp`}
        width={384} height={384} alt="" fetchPriority="high" />
      <div className="loading-caption">
        <div className="loading-title">hydrogen</div>
        <div className="loading-state">hydrogen orbitals</div>
        <div className="loading-bar"><i id="loading-bar" /></div>
        <div id="loading-note" className="loading-note">starting</div>
      </div>
    </div>
  );
}

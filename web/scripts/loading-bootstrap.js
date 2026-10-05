// Appended to the self-contained orbitalFactory by bake-loading-runtime.mjs.
(() => {
  const root = document.getElementById('loading');
  const first = document.getElementById('loading-first-frame');
  const canvas = document.getElementById('loading-worker');
  if (!root || !first || !canvas || window.__hydrogenLoader) return;
  const epoch = performance.timeOrigin + performance.now();
  const animate = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  let boot = null, worker = null, url = null, disposed = false;
  const stopWorker = (graceful = false) => {
    if (worker && graceful) {
      const current = worker;
      current.onmessage = () => current.terminate();
      current.postMessage(null);
      setTimeout(() => current.terminate(), 250);
    } else worker?.terminate();
    worker = null;
    if (url) URL.revokeObjectURL(url);
    url = null;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    stopWorker(true); boot?.dispose(); boot = null;
    resolveReady();
  };
  const observer = new MutationObserver(() => { if (root.hidden || !root.isConnected) dispose(); });
  observer.observe(root, { attributes: true, attributeFilter: ['hidden'] });
  observer.observe(root.parentNode, { childList: true });
  window.addEventListener('pagehide', dispose, { once: true });
  window.__hydrogenLoader = { ready, dispose };
  // The first draw happens in this parser-executed script, before React loads.
  boot = orbitalFactory(first, epoch, animate);
  if (!boot || !animate || !canvas.transferControlToOffscreen || !window.Worker) {
    resolveReady(); return;
  }
  try {
    // The worker's code travels inside this same script, without another fetch.
    const source = 'self.onmessage=({data})=>{const scene=(' + orbitalFactory.toString() + ')(data.canvas,data.epoch,true);if(!scene){self.postMessage(false);return;}self.onmessage=()=>{scene.dispose();self.postMessage(null);self.close();};requestAnimationFrame(()=>self.postMessage(true));};';
    url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = ({ data }) => {
      if (disposed) return;
      if (url) URL.revokeObjectURL(url);
      url = null;
      if (data) {
        first.hidden = true;
        boot?.dispose(); boot = null;
      } else stopWorker();
      resolveReady();
    };
    worker.onerror = () => {
      stopWorker(); resolveReady(); // Keep the first renderer as fallback.
    };
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ canvas: offscreen, epoch }, [offscreen]);
  } catch {
    stopWorker(); resolveReady();
  }
})();

"use client";

import dynamic from "next/dynamic";

// Keep the WebGL viewer out of server rendering while its loading shell is
// rendered in the page's initial HTML.
const OrbitalViewer = dynamic(() => import("./OrbitalViewer"), { ssr: false });

export default function ViewerClient() {
  return <OrbitalViewer />;
}

"use client";

// The viewer is pure client-side WebGL; skipping SSR avoids prerendering a
// component whose entire body lives in a useEffect anyway.
import dynamic from "next/dynamic";

const OrbitalViewer = dynamic(() => import("../components/OrbitalViewer"), {
  ssr: false,
});

export default function Page() {
  return <OrbitalViewer />;
}

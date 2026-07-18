import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hydrogen Orbitals",
  description:
    "Interactive hydrogen-atom wavefunction visualizer — analytic ψ_nlm evaluated per pixel in WebGL2.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

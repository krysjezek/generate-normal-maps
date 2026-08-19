import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Normal Map Generator",
  description: "Generate tangent-space normal maps from heightmaps in the browser.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

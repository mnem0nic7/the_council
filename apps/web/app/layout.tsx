import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Council",
  description: "Starship agent mission control"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-cyan-300 focus:px-4 focus:py-2 focus:text-slate-950 focus:font-semibold"
        >
          Skip to main content
        </a>
        <div id="main-content">
          {children}
        </div>
      </body>
    </html>
  );
}

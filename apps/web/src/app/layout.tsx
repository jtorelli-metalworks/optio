import type { Metadata } from "next";
import { Sora, IBM_Plex_Mono } from "next/font/google";
import { LayoutShell } from "@/components/layout/layout-shell";
import "./globals.css";

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm-mono",
});

export const metadata: Metadata = {
  title: "Optio",
  description: "Workflow orchestration for AI coding agents",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Inject runtime config so client-side code can derive the API WebSocket URL.
  // PUBLIC_API_URL is the browser-reachable API URL (e.g. http://localhost:30400
  // for local dev with NodePort, or empty for production ingress where web and
  // API share the same host).
  const publicApiUrl = process.env.PUBLIC_API_URL ?? "";

  // Default to light; ThemeProvider applies stored preference on mount
  return (
    <html
      lang="en"
      className={`light ${sora.variable} ${ibmPlexMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Runtime config for client-side JS (WebSocket URL derivation) */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__OPTIO_CONFIG=${JSON.stringify({ publicApiUrl }).replace(/</g, "\\u003c")}`,
          }}
        />
        {/* Inline script to prevent flash of wrong theme */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("optio_theme");var r="light";if(t==="dark")r="dark";else if(t==="system")r=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.classList.remove("light","dark");document.documentElement.classList.add(r)}catch(e){}})()`,
          }}
        />
      </head>
      <body className="antialiased">
        <LayoutShell>{children}</LayoutShell>
      </body>
    </html>
  );
}

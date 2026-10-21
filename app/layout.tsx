import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { Providers } from "@/components/providers";
import { ConnectionBanner } from "@/components/connection-banner";
import "./globals.css";

const bodyFont = localFont({
  src: "./fonts/dm-sans-latin.woff2",
  variable: "--font-body",
  display: "swap",
  weight: "100 900",
});
const headingFont = localFont({
  src: "./fonts/space-grotesk-latin.woff2",
  variable: "--font-heading",
  display: "swap",
  weight: "300 700",
});

export const metadata: Metadata = {
  title: "Collab · A space to build together",
  description:
    "Bring your team's projects, documents, code and conversations into one shared workspace.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${bodyFont.variable} ${headingFont.variable}`}
    >
      <head>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `(()=>{let p="system";try{const s=localStorage.getItem("collab:theme");if(s==="light"||s==="dark")p=s}catch{}document.documentElement.dataset.themePreference=p;document.documentElement.dataset.theme=p==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p})()`,
          }}
        />
      </head>
      <body>
        <Providers>
          <ConnectionBanner />
          {children}
        </Providers>
      </body>
    </html>
  );
}

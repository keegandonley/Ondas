import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://ondas.keegan.codes";
const title = "Ondas — On-device AI chat for Mac";
const description =
  "Ondas is an on-device chat app built with Apple Intelligence. Chats sync with iCloud, and optional telemetry can send usage data to an endpoint you choose.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  applicationName: "Ondas",
  icons: { icon: "/icon.png", apple: "/icon.png" },
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "Ondas",
    title,
    description:
      "Chat and image generation run on your Mac with Apple Intelligence. Chats sync with iCloud; telemetry is optional.",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description:
      "Chat and image generation run on your Mac with Apple Intelligence. Chats sync with iCloud; telemetry is optional.",
  },
};

export const viewport: Viewport = {
  themeColor: "#1E6BF6",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}

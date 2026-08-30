import type { Metadata } from "next";
import "./globals.css";
import "./chat.css";

export const metadata: Metadata = {
  title: "Ondas",
  description: "On-device AI chat, running entirely in your browser.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

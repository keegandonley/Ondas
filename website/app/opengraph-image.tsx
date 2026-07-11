import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Route segment config
export const alt = "Ondas — On-device AI chat for Mac";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  const iconData = await readFile(join(process.cwd(), "public", "icon.png"));
  const iconSrc = `data:image/png;base64,${iconData.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 96px",
          backgroundColor: "#0e1c2e",
          backgroundImage:
            "radial-gradient(60% 80% at 12% 18%, rgba(34,193,242,0.42), transparent 60%), radial-gradient(60% 80% at 92% 92%, rgba(30,107,246,0.45), transparent 62%)",
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={iconSrc}
            alt=""
            width={200}
            height={200}
            style={{
              borderRadius: 46,
              boxShadow: "0 30px 70px rgba(30,107,246,0.55)",
            }}
          />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                fontSize: 108,
                fontWeight: 800,
                letterSpacing: "-0.03em",
                lineHeight: 1,
              }}
            >
              Ondas
            </div>
            <div
              style={{
                fontSize: 38,
                fontWeight: 600,
                color: "#a9ddf7",
                marginTop: 18,
              }}
            >
              On-device AI chat for Mac
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            fontSize: 34,
            color: "#c7d6ea",
            marginTop: 56,
            maxWidth: 900,
            lineHeight: 1.35,
          }}
        >
          Chat and image generation powered by Apple Intelligence — running
          entirely on your device.
        </div>

        <div
          style={{
            display: "flex",
            marginTop: 44,
            fontSize: 27,
            fontWeight: 600,
            color: "#eaf3ff",
            backgroundColor: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 999,
            padding: "16px 30px",
            alignSelf: "flex-start",
            fontFamily: "monospace",
          }}
        >
          brew install --cask keegandonley/tap/ondas
        </div>
      </div>
    ),
    { ...size },
  );
}

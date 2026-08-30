import type { NextConfig } from "next";

// The chat surface is client-only: `LanguageModel` is a window global with no Worker or
// server counterpart (see web/PORTING.md § The verified Prompt API surface), so nothing
// under src/chat, src/data or src/features can be server-rendered.
const nextConfig: NextConfig = {};

export default nextConfig;

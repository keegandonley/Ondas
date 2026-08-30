import { defineConfig } from "vitest/config";

export default defineConfig({
  // The root tsconfig sets `"jsx": "preserve"` because Next.js compiles JSX itself. Vite reads
  // that setting, so without this override it hands preserved JSX to its own SSR transform, which
  // cannot parse it — every `.tsx` test fails to load with "Unexpected JSX expression" before a
  // single assertion runs. Next's build is unaffected; this only tells the test transform to emit
  // the automatic runtime.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    // `src/kit` and `src/design` are deliberately DOM-free — the boundary `:ondaskit` enforces
    // on Android. Specs that need a DOM (src/data's IndexedDB store, src/features) set their own
    // environment per file with a `// @vitest-environment` pragma, so a stray `document`
    // reference in the pure layer fails here rather than passing under a global jsdom.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // No `passWithNoTests`. A suite that reports success while running nothing is the exact
    // "tests that cannot fail" pattern the vault warns about; if this errors with "no test
    // files found", that is the correct failure.
  },
});

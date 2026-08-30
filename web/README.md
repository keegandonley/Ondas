# Ondas for the web

A port of the Ondas chat app to Chrome's built-in on-device model. Runs entirely in the browser:
no account, no Ondas-operated endpoint, no server-side inference.

**Read [PORTING.md](PORTING.md) before changing anything here.** It is the binding document — it
carries the porting rule, the verified `LanguageModel` surface, the approved drifts, and the
decisions still awaiting a call.

## Requirements

Desktop Chromium (Chrome/Edge) 148 or newer. `LanguageModel` is unavailable in Safari and Firefox
and there is no polyfill — Mozilla's position is *Negative*, WebKit's is *Oppose*.

## Develop

```bash
npm install
npm run dev       # http://localhost:3000
```

## Gate

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

## Layout

| Path | Contents |
|---|---|
| `src/kit/` | Pure TS domain layer — no DOM, no `LanguageModel`, no React |
| `src/chat/` | `ChatEngine` and the `OnDeviceModel` boundary |
| `src/data/` | IndexedDB store |
| `src/features/` | Chat, conversations, settings |
| `src/design/` | Theme tokens, pinned to the iOS asset catalog |
| `src/ui/` | Composition root, the React adapter for `ChatEngine`, and all user-visible copy |
| `app/` | Next App Router shell, global styles, and `/probe` |

## `/probe`

A diagnostic route that re-runs the Chrome `LanguageModel` spike in the app: availability, the
runtime context window, whether streaming yields deltas or cumulative snapshots, and the error
taxonomy. PORTING.md records that surface as measured rather than documented — this is how you
check it is still true on a different machine or a newer Chrome.

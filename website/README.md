# Ondas marketing site

A minimal [Next.js](https://nextjs.org) (App Router) site for [ondas.keegan.codes](https://ondas.keegan.codes).

## Develop

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # production build
```

## Deploy (Vercel)

This app lives in a subdirectory of the Ondas repo. In the Vercel project settings set **Root Directory** to `website`. Everything else (build command, output) is auto-detected.

- **OG image** — generated at `/opengraph-image` from `app/opengraph-image.tsx` (Next `ImageResponse`). Referenced automatically via the file-based metadata convention.
- **Analytics** — `@vercel/analytics` is mounted in `app/layout.tsx`; it activates automatically once Web Analytics is enabled for the project.
- **Canonical domain** — defaults to `https://ondas.keegan.codes`. Override with the `NEXT_PUBLIC_SITE_URL` env var if the domain changes.

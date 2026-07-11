import { CopyButton } from "@/components/CopyButton";

const INSTALL_COMMAND = "brew install --cask keegandonley/tap/ondas";

const FEATURES = [
  {
    title: "On-Device Intelligence",
    body: "Chat with Apple's Foundation Models running locally. These are tiny models and aren't very smart, but it's fun to explore.",
  },
  {
    title: "Optional Personal Telemetry",
    body: "Off by default. Send model and timing data to an HTTPS endpoint you choose; transcripts require a separate opt-in.",
  },
  {
    title: "iCloud Sync",
    body: "Chats and generated images can sync across your devices through your iCloud account.",
  },
  {
    title: "Image Generation",
    body: "Ask for a picture and Ondas creates it with Apple's Image Playground model.",
  },
];

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v12" />
      <path d="m7 12 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

export default function Home() {
  return (
    <>
      <header className="nav">
        <div className="wrap nav-inner">
          <a className="brand" href="#top">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.png" alt="Ondas icon" />
            Ondas
          </a>
          <a className="btn btn-sm hide-sm" href="#download">
            <DownloadIcon />
            Install for Mac
          </a>
        </div>
      </header>

      <main id="top">
        {/* HERO */}
        <section className="hero">
          <div className="hero-glow" />
          <div className="wrap">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="app-icon" src="/icon.png" alt="Ondas app icon" />
            <h1>
              Chat With <span className="grad">Apple Intelligence</span>
            </h1>
            <p className="lead">
              Ondas is a simple chat app for the on-device Apple Intelligence
              model on your Mac.
            </p>
            <div className="cta-row">
              <a className="btn" href="#download">
                <DownloadIcon />
                Install for Mac
              </a>
              <a className="btn ghost" href="#features">
                See what it does
              </a>
            </div>
            <p className="req">
              Requires <strong>macOS 26</strong> · Apple silicon · Apple
              Intelligence enabled
            </p>
          </div>

          {/* wave divider */}
          <div className="wave-divider" aria-hidden="true">
            <svg
              viewBox="0 0 1440 120"
              preserveAspectRatio="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <defs>
                <linearGradient id="wg" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stopColor="#22C1F2" />
                  <stop offset="1" stopColor="#1E6BF6" />
                </linearGradient>
              </defs>
              <path
                fill="#A9DDF7"
                fillOpacity="0.45"
                d="M0,64 C240,110 480,10 720,48 C960,86 1200,120 1440,72 L1440,120 L0,120 Z"
              />
              <path
                fill="url(#wg)"
                fillOpacity="0.12"
                d="M0,80 C240,40 480,120 720,84 C960,48 1200,20 1440,60 L1440,120 L0,120 Z"
              />
              <path
                fill="#F4F8FC"
                d="M0,92 C240,120 480,64 720,80 C960,96 1200,124 1440,96 L1440,120 L0,120 Z"
              />
            </svg>
          </div>
        </section>

        {/* FEATURES */}
        <section className="features" id="features">
          <div className="wrap">
            <div className="section-head">
              <p className="eyebrow">What is Ondas?</p>
              <p>
                Ondas has no separate account. Chat and image generation run on
                your device; chats sync through iCloud, and telemetry is
                optional.
              </p>
            </div>
            <div className="grid">
              {FEATURES.map((feature) => (
                <div className="card" key={feature.title}>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ABOUT BAND */}
        <section className="band">
          <div className="wrap">
            <h2>A project by keegan.codes</h2>
            <p>
              I&apos;m a principal front-end engineer who spends most of my time
              in TypeScript, API design, and web architecture. Ondas is a tool I
              built, assisted by AI, to explore what Apple&apos;s on-device
              foundation models can do.
            </p>
            <div className="band-links">
              <a
                className="band-link"
                href="https://github.com/keegandonley/Ondas"
                target="_blank"
                rel="noopener"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.17.08 1.78 1.2 1.78 1.2 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.4-5.26 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .5Z" />
                </svg>
                View source on GitHub
              </a>
              <a
                className="band-link"
                href="https://keegan.codes"
                target="_blank"
                rel="noopener"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
                </svg>
                Read my blog
              </a>
            </div>
          </div>
        </section>

        {/* DOWNLOAD */}
        <section className="download" id="download">
          <div className="wrap">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="app-icon" src="/icon.png" alt="Ondas app icon" />
            <h2>Get Ondas for Mac</h2>
            <p>
              Install with Homebrew and start a private conversation.
            </p>
            <div className="install">
              <code id="install-cmd">{INSTALL_COMMAND}</code>
              <CopyButton command={INSTALL_COMMAND} />
            </div>
            <p className="req">
              Requires <strong>macOS 26</strong> · Apple silicon · Apple
              Intelligence enabled
            </p>
          </div>
        </section>
      </main>

      <footer>
        <div className="wrap foot-inner">
          <div className="foot-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.png" alt="Ondas icon" />
            Ondas
          </div>
          <div className="foot-meta">© 2026 Ondas · On-device AI chat</div>
          <nav className="foot-links" aria-label="Project links">
            <a href="https://github.com/keegandonley/Ondas">Source</a>
            <a href="https://github.com/keegandonley/Ondas/blob/main/LICENSE">
              License
            </a>
            <a href="https://github.com/keegandonley/Ondas/blob/main/PRIVACY.md">
              Privacy
            </a>
            <a href="https://github.com/keegandonley/Ondas/blob/main/SECURITY.md">
              Security
            </a>
          </nav>
        </div>
      </footer>
    </>
  );
}

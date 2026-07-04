# Product

## Register

product

## Users

People who watch a lot of TV and movies and hate losing their place. Many are
arriving from TV Time (which is shutting down), so they already have the habit
of checking episodes off and expect their history to come with them. They use
showustv the way you use a remote: in short, frequent bursts, often on a phone
on the couch mid-binge, sometimes on a laptop while planning what to watch next.

The job to be done is continuity: "what do I watch next, and where was I?"
Secondary jobs are keeping a watchlist, tracking air dates so premieres and
finales don't slip past, rating what they've seen, and building lists they can
share with friends. The primary task on almost every screen is a single one:
mark an episode watched, or find the next unwatched one.

## Product Purpose

showustv is a TV-and-movie tracker in the spirit of TV Time: follow shows, mark
episodes watched, keep a watchlist, rate things, and build shareable lists.
Metadata comes from TMDB. The whole app is one Cloudflare Worker serving a React
SPA plus a Hono API on D1.

Success is the app being invisible: you open it, the next episode of everything
you follow is already lined up to the right spot, you tap it, you close the app.
The moment a user thinks "wait, where was I?" the product has failed. It wins by
being faster and more honest than the streaming apps' own "continue watching"
rows, and by outliving the trackers that came before it.

## Brand Personality

Playful, retro, tactile. The identity is analog broadcast: SMPTE color bars,
production slates (`S02·E05`), an ON AIR red light, a little TV bug in the
wordmark. That nostalgia is the personality, not a skin over a generic app.
It should feel made by someone who genuinely loves television, with the warmth
and small jokes that implies, and enough tactility that checking off an episode
is quietly satisfying.

Voice: direct, friendly, confident, occasionally funny. Short sentences. It
says "That's the whole form" and "wait, where was I?" It never oversells and
never talks like a SaaS onboarding email. The playfulness lives in the chrome,
the copy, and the empty states, never in the way of the one tap that matters.

## Anti-references

- **Streaming-service clone.** No Netflix/Max glossy-dark hero carousels, no
  autoplaying browse-and-stream vibe. This is a tracker, not a storefront.
- **Corporate SaaS sameness.** No Linear/Notion/generic-dashboard template feel:
  flat gray, identical repeated card grids, personality sanded off.
- **Generic Material/Bootstrap admin.** No off-the-shelf component-library
  defaults, purple primary buttons, or stock elevation.
- **Neon gamer/cinema aesthetic.** No neon-on-black, glow effects, aggressive
  gradients, or cyberpunk styling. The retro is warm and analog, not synthwave.

## Design Principles

- **Every claim maps to a shipped feature.** The landing and the copy describe
  only what the product actually does. No vaporware, no aspirational screenshots.
  Marketing shots are built from the app's own components so they can't drift.
- **The broadcast metaphor must be earned.** Slates, SMPTE bars, and the ON AIR
  red carry real meaning (episode codes, section breaks, live/airing state).
  When a motif stops meaning something, cut it rather than keep it as decoration.
- **Always answer "what's next?"** Continuity is the product. Every surface
  should make the next action, and the next episode, obvious with zero recall.
- **One tap is the whole interaction.** The critical path, marking watched and
  finding what's next, is a single action. Personality and detail never add a
  step to it.
- **Playful in the chrome, precise in the work.** Charm belongs in empty states,
  wordmark, and copy; the working surfaces (library, watch next, detail) stay
  legible, fast, and calm.

## Accessibility & Inclusion

Target WCAG 2.2 AA. Maintain AA contrast on the dark palette (amber, cyan, and
green on slate all meet it against `--bg`/`--surface`). Preserve the existing
practices already in the code: `:focus-visible` amber rings, a
`prefers-reduced-motion` block, ARIA roles on progress bars, spinners, and live
status, and disciplined `alt` text. Color is never the only signal (watched
state, ON AIR, and ratings each pair color with an icon, label, or code).

---
name: Show Us TV
description: A TV & movie tracker dressed as a late-night broadcast desk — slate, tungsten amber, and the ON AIR red.
colors:
  bg: "#0f1218"
  surface: "#171c26"
  surface-2: "#202836"
  line: "#2a3344"
  text: "#ede9e0"
  muted: "#8e97a8"
  amber: "#ffae2e"
  amber-soft: "#ffae2e24"
  amber-ink: "#1a1205"
  cyan: "#56cfde"
  red: "#ff4d3d"
  green: "#58c983"
typography:
  display:
    fontFamily: "Zilla Slab, Georgia, serif"
    fontSize: "clamp(32px, 6.5vw, 52px)"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Zilla Slab, Georgia, serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Zilla Slab, Georgia, serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Figtree, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Zilla Slab, Georgia, serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.14em"
  mono:
    fontFamily: "Spline Sans Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.04em"
rounded:
  xs: "4px"
  sm: "8px"
  md: "10px"
  lg: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
components:
  button-primary:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.amber-ink}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-lg:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.amber-ink}"
    rounded: "{rounded.md}"
    padding: "12px 26px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  slate:
    backgroundColor: "{colors.amber-soft}"
    textColor: "{colors.amber}"
    rounded: "{rounded.xs}"
    padding: "1.5px 6px"
  chip:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    padding: "3px 12px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "10px"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "22px 24px"
---

# Design System: Show Us TV

## 1. Overview

**Creative North Star: "The Analog Rewind"**

Show Us TV looks like the room where the tape lived. A dim slate wall, one warm
tungsten dial you keep reaching for, a cyan readout ticking off the schedule,
and a red light that means something is on the air right now. The whole product
runs on the vocabulary of analog broadcast, SMPTE color bars, production slates
(`S02·E05`), the ON AIR bulb, a little TV bug in the wordmark, but the nostalgia
is warm and worn, not neon. Think CRT glow and a well-thumbed VHS spine, not
synthwave. It should feel made by someone who genuinely loves television.

Density is calm and legible. This is a tool people open in short bursts on the
couch, so the working surfaces (library, watch next, show and episode pages) stay
quiet and fast; the personality lives in the chrome, the empty states, the
wordmark, and the copy, never in the path of the one tap that matters. The single
tungsten amber is used sparingly and always means "act here" or "your progress."
Everything else recedes into slate.

This system explicitly rejects the streaming-service look (no Netflix/Max glossy
hero carousels), corporate SaaS sameness (no flat-gray Linear/Notion dashboard
template, no identical repeating card grids), off-the-shelf Material/Bootstrap
defaults (no purple primary buttons, no stock elevation), and the neon
gamer/cinema aesthetic (no glow-on-black, no aggressive gradients). The retro is
analog and warm, never cyberpunk.

**Key Characteristics:**
- Deep slate room, dark by conviction, not by trend, with `color-scheme: dark`.
- One warm accent (tungsten amber) that only ever means action or progress.
- A three-light status language borrowed from a broadcast rack: red ON AIR, amber acting, green done.
- Broadcast props that carry real meaning: slates for episode codes, SMPTE bars for section breaks.
- Zilla Slab italic for identity, Spline Sans Mono for the "printed on the tape" details.

## 2. Colors

A dim slate room lit by a single tungsten bulb, with two cool signal lights and
one warm-white for text. Neutrals are tinted toward blue-slate; the warmth is
rationed to the amber.

### Primary
- **Tungsten Amber** (`#ffae2e`): The one warm light in the room. Primary buttons, active nav, progress-bar fill, focus rings, the slate chip, the "acting" state of the sync banner. It is the only color that says "do this" or "this is your progress," so it appears rarely and always with intent.
- **Amber Wash** (`#ffae2e24`): A 14%-opacity amber used as a tint behind active states, the slate chip, feature-icon tiles, and the amber sync banner. The glow of the bulb, not the bulb.
- **Amber Ink** (`#1a1205`): The near-black brown that sits *on* amber fills (button labels, slate text on a solid amber score dot). Never used as a surface.

### Secondary
- **Schedule Cyan** (`#56cfde`): The cool readout. All hyperlinks, the "coming up" eyebrow, the info banner, and the downvote in comment threads. Cyan is information and time; amber is action. Keep them apart.

### Tertiary
- **ON AIR Red** (`#ff4d3d`): The bulb that means live or destructive. The airing-now dot (with a soft glow), the favorite heart, danger buttons, error text, the failed-sync banner. Red is reserved for "on the air" and "careful."
- **Watched Green** (`#58c983`): The confirmation light. The episode check when it flips on, "season complete," the verified-email badge, the synced banner. Green appears only after a real success.

### Neutral
- **Slate Room** (`#0f1218`): The deepest background, the wall of the room. Also the translucent basis of the sticky header and tab bar.
- **Surface** (`#171c26`): Cards, tiles, the login/dialog panels, inputs. One step up from the wall.
- **Surface Riser** (`#202836`): The second tonal step, chips, pills, hover fills, progress track, the raised bits inside a surface.
- **Hairline** (`#2a3344`): Every border and divider. 1px, quiet, structural.
- **Warm White** (`#ede9e0`): Body and heading text. Faintly warm so it reads as tungsten-lit paper, never clinical `#fff`.
- **Muted Slate** (`#8e97a8`): Secondary text, labels, inactive nav, timestamps, the mono production details.

### Named Rules
**The Three-Light Rule.** Status is spoken in exactly three colored lights, red on air, amber acting, green done, plus cyan for schedule/info. A surface never invents a fifth status color; if a state needs signaling, it reuses one of these four with an icon or label beside it.

**The One Bulb Rule.** Amber is the only warm light in the room and it means action or progress, nothing else. It is never a decorative accent, a heading color, or a background field. Its scarcity is what makes a primary button obvious.

## 3. Typography

**Display Font:** Zilla Slab (Georgia, serif fallback)
**Body Font:** Figtree (system-ui, sans-serif fallback)
**Label/Mono Font:** Spline Sans Mono (monospace fallback)

**Character:** Zilla Slab is the marquee, a warm slab serif that brands titles,
wordmark, and headings with a confident italic lean, the retro TV-listings voice
of the whole system. Figtree is the calm, legible humanist workhorse for
everything you read. Spline Sans Mono is the label-maker: it prints the details
that would be stamped on the tape, episode codes, dates, counts, faux URLs, so
they read as "production metadata," not prose.

### Hierarchy
- **Display** (Zilla Slab 700 italic, `clamp(42px, 8.6vw, 92px)` on the landing hero): The marquee headline and the wordmark. Italic is the brand voice, used once per view.
- **Headline** (Zilla Slab 700, 28px, -0.02em): Page titles at the top of app screens.
- **Title** (Zilla Slab 700, 15–30px, -0.01em): Card and showcase headings, show/episode/movie H1s (H1s go italic to match the marquee), feature and list names, dialog titles.
- **Body** (Figtree 400/500, 15px app / 16–18px landing, line-height 1.5): All running text. Cap measure at 65–75ch; the codebase holds prose to `max-width: 46–72ch`.
- **Label** (Zilla Slab 700, 13px, uppercase, letter-spacing 0.14em): Section eyebrows, preceded by a 14px amber tick. Also the small uppercase stat labels.
- **Mono** (Spline Sans Mono 600, ~12–13px, letter-spacing 0.04–0.1em): Production details, slates, dates, pills, segment cues, faux browser URLs. Usually in Muted Slate; amber only inside a slate chip or as a segment number.

### Named Rules
**The Printed-On-The-Tape Rule.** Anything that would be physically stamped on a cassette or a shot list, episode codes, air dates, counts, runtimes, is set in Spline Sans Mono. Prose is never mono; metadata is never prose-set.

**The Italic-Is-The-Brand Rule.** The forward-leaning italic is reserved for the wordmark, the landing hero, and title-level show names. It is an identity signal, not emphasis; body copy never leans.

## 4. Elevation

Flat by conviction, depth comes from tonal layering, not shadow. The room is
built in four slate steps (`bg` → `surface` → `surface-2`, bordered by
`line`); you read hierarchy by lightness and a 1px hairline, not by drop
shadows. Shadow is rationed to two jobs only: a true overlay lifting off the
page, and the ON AIR glow.

### Shadow Vocabulary
- **Overlay Lift** (`box-shadow: 0 24px 64px rgba(0,0,0,0.55)`): Modal dialogs only, the one surface that genuinely floats above everything.
- **Hero Frame** (`box-shadow: 0 30px 70px -28px rgba(0,0,0,0.75)`): The framed product screenshots on the landing page, a photograph pinned to the wall.
- **ON AIR Glow** (`box-shadow: 0 0 6px rgba(255,77,61,0.8)`): The only *colored* shadow, and only on the live airing dot. It is light, not elevation.

### Named Rules
**The Flat-Room Rule.** Cards, tiles, chips, and panels are flat, distinguished by a lighter slate fill and a 1px `line` border. If a surface needs a shadow to separate from its background, the tonal step is wrong, fix the fill, not the shadow. Shadows are for things that truly float (dialogs, the hero photo) and for the ON AIR glow. Nothing else.

## 5. Components

### Buttons
- **Shape:** Softly rounded, 8px (`rounded.sm`); the large landing CTA steps up to 10px (`rounded.md`).
- **Primary:** Solid Tungsten Amber fill with Amber Ink text, `8px 16px` padding, 600 weight. Hover brightens the fill (`filter: brightness(1.08)`); active dips to `scale(0.98)` for a tactile press. This is the one loud control on any screen.
- **Ghost:** Transparent fill, `line` border, warm-white text. Hover lifts the border to Muted Slate, no brightness shift. The default for secondary actions and "Sign in."
- **Danger:** Ghost geometry with red text; hover lights the border red. Solid-danger (red fill, dark-red ink) is reserved for the confirm button inside a destructive dialog.
- **Link button:** No chrome, amber (or muted) text, underline on hover, for inline actions.
- **Touch:** On narrow screens every control grows to a ≥40px tap target.

### Chips & Pills
- **Slate** (signature): Mono episode code, amber-on-amber-wash, 4px radius. The `S02·E05` production stamp.
- **Pill:** Mono count on a Surface-Riser fill, fully round; used for "4 left" overlays and small counters.
- **Link chip** (external sites, friends): Surface-Riser fill, `line` border, fully round; hover shifts border and text to amber.

### Cards / Containers
- **Corner Style:** 10px (`rounded.md`) for tiles and cards; 14px (`rounded.lg`) for dialogs, the show hero, and framed screenshots.
- **Background:** Surface (`#171c26`) on the slate wall.
- **Shadow Strategy:** None, see the Flat-Room Rule. Separation is the lighter fill plus a 1px `line` border.
- **Border:** Always 1px `line`. Hover on interactive cards lifts the border to Muted Slate.
- **Internal Padding:** 10–12px on tiles, 18–22px on content cards and dialogs.

### Inputs / Fields
- **Style:** Surface fill, 1px `line` border, 8px radius, `8px 12px` padding.
- **Focus:** A 2px amber `outline` with the border faded to transparent, the same amber ring used everywhere for `:focus-visible`.
- **Signature:** The header and search fields are pill-shaped (`999px`) with an inline icon, a tuner readout more than a form field.
- **Mobile:** Inputs jump to 16px font on small screens so iOS Safari does not zoom.

### Navigation
- **Desktop header:** Sticky, translucent slate with an 8px backdrop blur, wordmark left, muted-slate nav links, a pill search, a gear. Active link is amber on an amber-wash fill.
- **Mobile tab bar:** Fixed bottom, five columns, translucent slate with blur, respecting the safe-area inset. Active tab is amber; icon over a 10.5px label.
- **Tabs / sub-tabs:** Underline tabs, muted at rest, amber text with an amber bottom-border when active.

### Signature Components
- **SMPTE bars** (`.smpte`): A 6px seven-band color-bar strip as a section divider and brand punctuation. The empty-state icon is the same bars at half opacity, a channel with no signal yet.
- **The Slate** (`S02·E05`): The recurring mono episode-code chip, the product's most-repeated brand atom.
- **ON AIR dot:** An 8px red dot with a soft red glow for airing-now; a hollow, `line`-bordered ring for a future air date. Color plus shape, never color alone.
- **Framed shot:** Product screenshots wrapped in a faux browser chrome, a Surface-Riser bar with red/amber/green traffic dots and a mono URL, so marketing previews are unmistakably *this* app.

## 6. Do's and Don'ts

### Do:
- **Do** keep amber to one job. A primary button, active state, or progress fill, never a heading color or decorative fill (the One Bulb Rule).
- **Do** speak status in the three lights plus cyan: red ON AIR, amber acting, green done, cyan schedule/info, and always pair the color with an icon, label, or code so color is never the only signal (WCAG 2.2 AA).
- **Do** build surfaces from the four slate steps (`bg`/`surface`/`surface-2`/`line`) and a 1px hairline. Depth is tonal, not shadowed (the Flat-Room Rule).
- **Do** set every episode code, date, count, and runtime in Spline Sans Mono; reserve Zilla Slab italic for the wordmark, landing hero, and show titles.
- **Do** use warm-white `#ede9e0` for text and the slate neutrals for chrome. Tint neutrals toward blue-slate; never reach for pure `#fff` or `#000`.
- **Do** give the ON AIR dot its soft red glow, the one colored shadow in the system, and grow tap targets to ≥40px on mobile.

### Don't:
- **Don't** make it a **streaming-service clone**: no Netflix/Max glossy-dark hero carousels or browse-and-stream autoplay. This is a tracker, not a storefront.
- **Don't** let it drift into **corporate SaaS sameness**: no flat-gray Linear/Notion dashboard template, no endless identical icon+heading+text card grids.
- **Don't** ship **generic Material/Bootstrap admin** defaults: no purple primary buttons, no stock elevation, no off-the-shelf component library look.
- **Don't** go **neon gamer/cinema**: no glow-on-black, no aggressive gradients, no cyberpunk. The retro is warm analog, not synthwave.
- **Don't** add drop shadows to separate flat surfaces, if a card doesn't read, fix the slate step, not the shadow.
- **Don't** use `background-clip: text` gradient text, decorative glassmorphism, or a `border-left`/`border-right` colored stripe wider than 1px as an accent. Use full 1px `line` borders, tonal fills, or the amber-wash tint instead.
- **Don't** print prose in mono or lean body text into italic, those are reserved signals.

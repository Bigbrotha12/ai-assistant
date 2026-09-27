# AI Assistant — Design System

> **Status: LOCKED** (approved via Stitch UI exploration).
> Primary screen = **voice-first** (single speak/push-to-talk button + quiet
> Transcript pill). Core = light/minimal; Premium = paper + gold-as-accent.
>
> **Amendments** (additive; no existing token or rule changed):
> - §2.6 Buttons — the three button roles and the geometry-only rule for
>   `AppButtons`. The text button was previously unstyled in `ThemeData`.
> - §5.1 Card-per-step onboarding — the dot-stepper pattern, and an explicit
>   "do not use Material's `Stepper`" note recording why.
>
> Both were added after the onboarding rework; the locked core and premium
> tokens in §2–§3 are unchanged.

Source of truth for the app's visual language. Two tiers:

- **Core (default)** — modern, light, very simple, minimal noise.
- **Premium** — a refined tier for premium users: premium-paper texture with a
  gold metallic band on edges and button edges.

Everything below is expressed as **tokens** that map to Flutter `ThemeData`
(material 3). Tokens live in code as `lib/app/theme.dart`; this doc is the
human-readable spec, and the two are kept in step — if they disagree, the code
is what ships, so fix both.

Related shared components:

| Component | File |
|-----------|------|
| Button roles (§2.6) | `lib/app/widgets/app_buttons.dart` |
| Onboarding step indicator (§5.1) | `lib/app/widgets/step_dots.dart` |
| Premium gold edge / pill | `lib/app/widgets/gold_band.dart`, `lib/app/widgets/golden_pill.dart` |

---

## 1. Design principles

1. **Light and airy.** Near-white surfaces, generous whitespace, minimal
   elevation. Depth is implied by subtle borders/tints, not heavy shadows.
2. **Little noise.** One restrained accent color. Flat app bars, soft
   dividers, no gratuitous gradients or glows in the default tier.
3. **Legible.** Comfortable line-height, clear hierarchy via type weight/size
   (not color) and spacing.
4. **Consistent.** Every screen pulls from the same token set; no ad-hoc hex
   values.
5. **Premium only where it belongs (premium tier).** Gold and paper texture
   are premium-tier accents only — never the core default.

---

## 2. Core (default) tokens

### 2.1 Color — light

| Token            | Value      | Usage                                   |
|------------------|------------|-----------------------------------------|
| `surface`        | `#FBFBFC`  | App background / base card fill         |
| `surfaceRaised`  | `#FFFFFF`  | Input bar, elevated cards, sheets       |
| `surfaceTint`    | `#F2F3F5`  | Chips, secondary surfaces               |
| `onSurface`      | `#1B1C1E`  | Primary text                            |
| `onSurfaceWeak`  | `#6A6F76`  | Secondary / hint text                   |
| `outline`        | `#E3E4E8`  | Hairline dividers, input borders        |
| `primary`        | `#4A5D8A`  | Calm desaturated indigo (from current seed) |
| `onPrimary`      | `#FFFFFF`  | Text/icons on primary                   |
| `primarySoft`    | `#E9EDF5`  | Primary-tinted chip / subtle highlight  |
| `accent`         | `#5B8C8F`  | Reserved single accent (status/success) |
| `error`          | `#B3261E`  | Errors                                  |

Notes:
- `primary` is a **muted** indigo (not the loud `Colors.indigo`). Calm and
  low-saturation to keep "little noise".
- No dark mode yet. Amber/Gold below is premium-only.

### 2.2 Typography

Headline font: `Manrope` — Body font: `Manrope` (label font `Manrope`).

A single geometric-grotesque family with weight + size for hierarchy keeps the
default tier calm and "noise-free". `Manrope` is a contemporary, slightly
technical grotesque — clean, modern, and far less ubiquitous than `Inter` —
with a friendly roundness that also pairs well with the premium serif (below).

| Role      | Size | Weight | Line-height | Letter-spacing |
|-----------|------|--------|-------------|----------------|
| display   | 28   | 700    | 1.25        | -0.02em        |
| title     | 22   | 600    | 1.3         | -0.01em        |
| heading   | 17   | 600    | 1.35        | 0              |
| body      | 15   | 400    | 1.5         | 0              |
| label     | 13   | 500    | 1.4         | 0.01em         |
| caption   | 12   | 400    | 1.4         | 0.01em         |

### 2.3 Shape / radius

- Buttons, inputs, chips, cards: **12px** (`ROUND_TWELVE`-style).
- Message bubbles (user): **16px** with a 4px bottom-right accent.
- Full-round for FAB, avatars, toggle.

### 2.4 Spacing

Base unit = **4px**. Spacing scale: `4, 8, 12, 16, 24, 32, 48, 64`.
Default page padding: **16px**; gap between list items: **8px**; card inner
padding: **16px**.

### 2.5 Elevation / borders

Prefer **1px hairline border** (`outline`) over shadows. Minimal elevation:
- App bar: flat, `surface`, hairline bottom divider. No shadow.
- Input bar: `surfaceRaised`, hairline top divider, small soft shadow.
- Cards: `surfaceRaised` + 1px `outline` border + radius 12.

### 2.6 Buttons

Three roles. A screen or step gets **at most one CTA** — two filled primary
buttons stacked read as competing actions and is a layout bug, not a style
choice.

| Role | Token (`AppButtons`) | Size | Fill | Use for |
|------|----------------------|------|------|---------|
| CTA | `cta` | full width × **52px** | filled `primary` | the single primary action of a screen or step |
| Regular | `regular` | hugs label × **48px** | filled `primary` | a standard action in a row or list |
| Regular, secondary | `regularOutlined` | hugs label × **48px** | outlined `outline` | the outlined counterpart to `regular` |
| Text | `text` | hugs label × **48px** min tap target | none | Back, "do it later", inline links |

The **48px minimum height on every role** is a tap-target floor, not a visual
size — quiet actions are sized to a comfortable thumb target rather than to
their label's own bounds.

**The shared styles set geometry only.** `AppButtons` in
`lib/app/widgets/app_buttons.dart` constrains size and padding and nothing
else; colour, corner radius, disabled colours and the label text style all stay
owned by `ThemeData` (`filledButtonTheme` / `outlinedButtonTheme` /
`textButtonTheme` in `lib/app/theme.dart`). That is deliberate: a tier or
palette change then restyles every button in the app with no call-site changes.
**Never hardcode a colour, radius or font size on a button in a feature
screen** — if a role is missing, add it to `AppButtons` rather than styling
locally.

---

## 3. Premium tokens

Applied to the **premium tier** only, layered on top of the core tokens so the
structure is identical — only surface treatment and accent change.

### 3.1 Premium paper texture

- **Base surface:** warm ivory paper `#F6F2E9` (instead of `#FBFBFC`), with a
  very subtle hand-laid paper grain.
- **Texture:** a low-visibility mottled grain (SVG/PNG tile or a
  `CustomPainter` that adds faint fibrous variation + a few darker speckles).
  Opacity kept under ~4–6% so it reads as "premium paper", not noise.
- **Typography (optional, premium only):** headline font swaps to an elegant
  old-style serif — `EB Garamond` (primary; `Lora` as a warmer, more modern
  alternative) — for the brand moments (headings on chat/home), while body
  text stays `Manrope` for legibility.

### 3.2 Gold metallic band

A restrained **gold** metallic treatment reserved for **edges** and **button
edges**:

- **Gold base:** soft champagne gold `#C8A24B`.
- **Gradient (metallic look):** vertical/diagonal sweep between
  `#E3C87A` → `#C8A24B` → `#9C7A2E` so it reads as brushed metal, not flat
  yellow.
- **Band thickness:** ~1.5–2px for hairline bands; up to 3px on primary CTAs.
**Gold is always an ACCENT — never a solid button/panel fill.** It appears only
as a thin metallic **border/band**, and the metallic effect comes from a
**subtle lightness variation** across the gradient (brushed metal, not flat
yellow).

- **Where applied:**
  - Primary **CTA** (speak button): an **ivory/paper fill** with a subtle gold
    edge **band** — never a gold body.
  - **Premium pill controls** (e.g. the **Transcript** button): a thin
    metallic gold **border** on a rounded pill — the signature "golden border".
    Spec: a 1.5px hairline **gradient** border (`#E3C87A → #C8A24B → #9C7A2E`)
    with a gentle lightness sweep so it shimmers like metal, on an
    **ivory/paper fill** (NOT gold-filled) with dark text.
    - The pill's **chevron points UP** (^) whenever the panel expands
      **upward** (e.g. Transcript rising from the bottom).
  - **App bar:** a 1.5px gold hairline along its bottom edge.
  - **Card edges:** a thin gold line on the top+bottom of cards (not all four
    sides).
- **Gold tokens:**

| Token        | Value     |
|--------------|-----------|
| `goldBase`   | `#C8A24B` |
| `goldLight`  | `#E3C87A` |
| `goldDark`   | `#9C7A2E` |
| `goldBand`   | 1.5px     |
| `paperBase`  | `#F6F2E9` |

### 3.3 Engraved metallic gold glyph (mic icon)

The primary **mic icon** on the speak button is an **engraved** metallic-gold
glyph (not a flat black/white icon):

- **Engraved look:** an inner bevel/emboss — a soft highlight along the
  top-left edge and a subtle darker ridge along the bottom-right — so the
  glyph reads as **etched into** the button, not painted on.
- **Metallic gold color:** fill the glyph with the gold gradient
  (`#E3C87A → #C8A24B → #9C7A2E`) using a subtle **lightness variation** across
  the glyph. That variation is what makes it look like **polished metal**.
- Size ≈ **1/3 of the button diameter**; stroke weight tuned to read at display
  size.

### 3.4 Voice-first premium screen (primary)

- **Speak button (hero):** ivory/paper fill, gold edge **band**, and a soft
  **breathing / pulse** animation plus an **animated concentric ring**
  (idle = gentle ring; active = current state: listening → processing →
  speaking). Combines the ring animation with the bevel/soft-shadow depth and
  the breathing motion.
- **Serif hero heading** "Speak" (EB Garamond) above the button, large.
- **Transcript button:** the §3.2 **golden-border** pill with an **up
  chevron** (panel expands upward).
- Composition + font-size follow the core scale; gold stays accent-only.

### 3.5 Premium surface rules

Everything else (spacing, radius, hierarchy) is **unchanged** from core so
premium stays recognizably the same product. Only:
- surface color → paper,
- accent → gold edge band,
- optional serif headlines.

---

## 4. Usage map (what each screen gets)

| Surface                          | Core                                     | Premium                                       |
|----------------------------------|------------------------------------------|-----------------------------------------------|
| App bar                          | flat `surface`, hairline divider          | flat paper, **gold bottom hairline**          |
| Message bubble (user)            | `primarySoft`, radius 16 (4 bottom-right) | paper-infused `primarySoft`, no band          |
| Message bubble (assistant)       | `surfaceRaised`, 1px outline              | `surfaceRaised` (paper tint), hairline        |
| Input bar                        | `surfaceRaised`, hairline top             | paper, gold hairline top                      |
| Primary CTA / Send button        | filled `primary`, radius 12               | **gold gradient band** + ivory fill           |
| Secondary buttons                | outlined `outline`, radius 12             | outlined `goldDark` hairline                  |
| Cards / settings sections        | `surfaceRaised` + 1px outline             | paper + **gold top/bottom edge band**         |
| Chips (tool-call, attachments)   | `surfaceTint`, radius 12                  | paper tint, gold hairline border              |
| Voice FAB                        | filled `primary`                          | **gold gradient ring** + ivory fill           |
| Speak button (voice home)        | filled `primary`, full-round              | ivory/paper fill, gold edge **band**, breathing + animated ring, **engraved metallic-gold mic glyph** |
| Transcript button (voice home)   | quiet pill, `surfaceTint`                 | **golden-border pill** (§3.2) with an **UP chevron** |
| Onboarding step card             | `surfaceRaised` + 1px outline             | paper + 1px `PaperTones.outline`              |
| Onboarding step indicator        | elongated active `primary`, inactive `outline`| `primary` active, `PaperTones.outline` inactive |
| Onboarding action bar            | `surface`, hairline top divider           | flat paper, hairline top divider              |

> **Note on the Premium column.** Gold is wired into `ThemeData` for the app
> bar, outlined buttons, chips and focused input borders only. The global
> **filled** button (`filledButtonTheme`) and `cardTheme` deliberately keep
> `primary` / `outline` in both tiers — the gold CTA band and the gold card
> edge in §3.2 belong to the voice-home brand moments
> (`lib/app/widgets/speak_button.dart`, `lib/app/widgets/golden_pill.dart`),
> not to every surface in the app. Onboarding is a setup
> flow rather than a brand moment, so it stays understated in both tiers. If
> that is not the intent, the fix belongs in the theme, not in a feature screen.

---

## 5. Flow patterns

### 5.1 Card-per-step onboarding (dot stepper)

Onboarding walks Account → Language & region → Voice & models → Finish as
**one step per card**, not as an expanded accordion.

**Do not use Material's `Stepper` for this.** Both `StepperType.vertical` and
`StepperType.horizontal` fail the brief:

- `vertical` renders every step stacked, and draws each step's controls
  *inline inside its own body* — so step 1's buttons end up flush against
  step 2's header with no gap between them.
- `horizontal` is a row of *numbered* headers joined by a connector line. It
  is not a dot indicator and gives no per-step card.

Structure:

```
App bar (flat, hairline bottom)
  └ Step indicator row        centred dots, vertical padding 16px
      └ Step card            Expanded; 16px side margins, 0 top, 16px bottom
          └ hairline divider
              └ Action bar    16px padding all round
                  └ CTA (full width)  [+ Back as a text button]
```

Rules:

- **One card visible at a time.** Step bodies live in a `PageView`; a step's
  content is not built until it is first shown.
- **Cards keep themselves alive once visited** (`AutomaticKeepAliveClientMixin`).
  A `PageView` disposes off-screen pages, which would tear down the Account
  step's auth form — and the text the user already typed — the moment they
  advanced. Hoist the controllers to the screen instead if a step's state ever
  needs to outlive more than one visit.
- **Card content is scrollable**; the card's own borders stay pinned, so a tall
  form (or the soft keyboard) never breaks the layout.
- **The card fills the space between the dots and the action bar.** The card
  keeps the same height across steps so the layout does not reflow as you
  advance; content that is short leaves the slack *inside* the card rather than
  collapsing the card.
- **Exactly one filled primary button per step.** The step's action lives in the
  sticky action bar, not inside the card. A form that would otherwise render
  its own submit (`AuthFlow`) takes `showSubmit: false` and lets the CTA drive
  it — two stacked filled buttons is the failure this rule exists to prevent.
- **Everything is inset.** The card and the CTA carry 16px margins, and there is
  at least 16px of clear space between the card's bottom edge and the action
  bar's divider. **Nothing is flush against a screen edge or another element.**
  This is the specific defect the card-per-step rework was commissioned to fix;
  the regression tests in `test/features/onboarding/onboarding_test.dart` assert
  both insets.
- **Navigation is Next/Back, not swipe.** Horizontal drags are disabled
  (`NeverScrollableScrollPhysics`): the cards host a keyboard, a
  `SegmentedButton` and dropdowns, and a drag competes with all three. The dots
  are tappable **backwards only** — a forward tap is refused so the user cannot
  skip past a step whose validation has not run.

#### Step indicator

Horizontal dots from `StepDots` (`lib/app/widgets/step_dots.dart`), wrapping
`smooth_page_indicator`'s `ExpandingDotsEffect`. Material 3 ships no
dot/page indicator, so this is the one place the app takes that dependency.

- The **active dot is elongated** (6 → 18px wide), so it reads as both "you are
  here" and "there are N steps". Inactive dots are 6px circles at 8px spacing.
- **Two-tone only** — active + inactive. `ExpandingDotsEffect` takes exactly two
  colours, and a third "completed" state would mean a second indicator or a
  custom painter: more machinery than "little noise" justifies at four steps.
- The package's built-in colours are hardcoded and **ignore `ThemeData`**, so
  colours are seeded from the active scheme in two places, both owned by
  `StepDots`: `effectFor(scheme)` and `colorsFor(scheme)`. The app root
  (`lib/main.dart`) feeds these into `SmoothPageIndicatorTheme` so any future
  indicator inherits them rather than repeating the numbers.
- The package paints the dots as a bare `CustomPaint` with **no semantics node**,
  so `StepDots` supplies one (`Step N of M`) and excludes the painted widget.
  "Back" remains the accessible way to move between steps.

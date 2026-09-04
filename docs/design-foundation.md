# Design foundation

Scope: enough visual direction that future screens are not designed in a vacuum. This is
**not** a complete identity system — that belongs to a design PR.

## Source of truth

`logo.png` at the repository root is the official initial identity. It is committed as
the single source; `apps/mobile/assets/brand/logo.png` is a build-time copy so the
Flutter toolchain can bundle it.

When the logo changes, replace the root file and re-copy:

```bash
cp logo.png apps/mobile/assets/brand/logo.png
```

## What the asset actually is

Measured, not assumed:

| Property | Value |
| --- | --- |
| Dimensions | 1024 × 1024 |
| Format | PNG, 8-bit RGB, non-interlaced |
| Alpha channel | **No** — the background is opaque, not transparent |
| Colour profile | sRGB IEC61966-2.1 |

**Composition.** A map pin whose negative space forms a winding trail of connected
waypoint nodes, above a heavy geometric sans wordmark reading "TRILHA". Two colours
only: a single flat green mark on a warm off-white ground, with a subtle paper grain.

## Palette derived from the asset

Sampled programmatically across all 1,048,576 pixels rather than eyeballed.

| Token | Value | Derivation |
| --- | --- | --- |
| `AppColors.brandGreen` | `#0D7D3C` | Modal colour of the 167,001 green pixels |
| `AppColors.surfaceLight` | `#F6F5F1` | Mean of the background pixels |
| `AppColors.brandGreenDark` | `#085C2B` | Darkened for pressed states and high-contrast text |
| `AppColors.brandGreenLight` | `#4CAF6E` | Lightened for dark surfaces |
| `AppColors.inkLight` | `#1A1C18` | Warm near-black; pure black reads harsh on the off-white ground |
| `AppColors.surfaceDark` | `#12140F` | Dark counterpart, warmth preserved |

### Measured contrast

| Pair | Ratio | Verdict |
| --- | --- | --- |
| `brandGreen` on `surfaceLight` | 4.79:1 | WCAG AA for normal text |
| White on `brandGreen` | 5.23:1 | AA — filled buttons are safe |

The brand green does **not** clear AA on a dark ground, which is why the dark theme uses
`brandGreenLight` as its primary. Both themes are asserted against WCAG AA by
`test/app/app_theme_test.dart`, which computes real relative luminance — a contrast
regression fails the build.

## Tokens

| File | Holds |
| --- | --- |
| `app/theme/app_colors.dart` | The palette above |
| `app/theme/app_typography.dart` | Type scale; sizes always scale with user preference |
| `app/theme/app_spacing.dart` | 4dp ramp plus `minTouchTarget = 48` |
| `app/theme/app_radius.dart` | Corner radii; generous, matching the pin's soft form |
| `app/theme/app_theme.dart` | Assembles Material 3 themes from the tokens |

**Approach.** The tonal palette is seeded from the logo's green via
`ColorScheme.fromSeed`, then the roles the brand actually owns — `primary` and
`surface` — are pinned to the sampled values. The result is neither a raw Material
default nor a palette that fights the logo.

## Typography

No custom font is bundled in PR-00. The wordmark carries the brand voice; the platform
default carries the UI. Choosing and licensing a typeface is a design decision with
licensing consequences, and it is deferred deliberately rather than guessed at.

## Accessibility commitments (§23)

- Text scales with the user's system preference; nothing caps or clamps `textScaler`.
  The root surface scrolls so it survives 2× scaling — asserted by test.
- Interactive targets are at least 48dp, enforced through the button themes.
- Both themes clear WCAG AA for body text and for text on primary — asserted by test.
- Colour is never the sole carrier of meaning; status colours pair with an icon or label.
- The logo carries a semantic label; the product name is marked as a heading.

## Deliberately not done

Iconography, illustration, motion, elevation language, map styling, a component
library, and light/dark logo variants. Each belongs to the PR that first needs it.

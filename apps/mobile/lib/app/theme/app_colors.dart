import 'package:flutter/material.dart';

/// Brand palette derived from `logo.png` (§21).
///
/// The values below were sampled from the asset rather than invented:
/// the mark is a single flat green on a warm off-white ground, so the palette
/// commits to that green as the primary and to the warm neutral as the surface.
/// See `docs/design-foundation.md` for the measurements.
abstract final class AppColors {
  const AppColors._();

  /// Modal green sampled from the logo mark. Contrast with [surface] is 4.79:1
  /// and with white 5.23:1, so it is safe for body text and for filled buttons.
  static const Color brandGreen = Color(0xFF0D7D3C);

  /// Darker green for pressed states and for text that must clear 7:1.
  static const Color brandGreenDark = Color(0xFF085C2B);

  /// Lighter green used on dark surfaces, where the brand green is too low-contrast.
  static const Color brandGreenLight = Color(0xFF4CAF6E);

  /// Warm off-white sampled from the logo background.
  static const Color surfaceLight = Color(0xFFF6F5F1);
  static const Color surfaceDark = Color(0xFF12140F);

  /// Neutral ink. Deliberately not pure black — it reads harsh on the warm ground.
  static const Color inkLight = Color(0xFF1A1C18);
  static const Color inkDark = Color(0xFFE3E3DC);

  /// Status colours. Each is paired with an icon or label in the UI so that colour
  /// is never the only carrier of meaning (§23).
  static const Color danger = Color(0xFFB3261E);
  static const Color dangerDark = Color(0xFFFFB4AB);
  static const Color warning = Color(0xFF8A5300);
  static const Color warningDark = Color(0xFFFFB86B);
}

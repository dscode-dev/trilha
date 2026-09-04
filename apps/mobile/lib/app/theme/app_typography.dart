import 'package:flutter/material.dart';

/// Type scale (§21).
///
/// Sizes are expressed in logical pixels and always scale with the user's text
/// size preference — nothing here caps or disables text scaling (§23).
abstract final class AppTypography {
  const AppTypography._();

  /// The wordmark is a heavy geometric sans. No custom font is bundled in PR-00,
  /// so the platform default carries the UI and the logo carries the brand voice.
  static const String? fontFamily = null;

  static TextTheme textTheme(Color ink) {
    final Color muted = ink.withValues(alpha: 0.70);

    return TextTheme(
      displaySmall: TextStyle(
        fontSize: 36,
        height: 1.15,
        fontWeight: FontWeight.w700,
        letterSpacing: -0.5,
        color: ink,
      ),
      headlineMedium: TextStyle(
        fontSize: 26,
        height: 1.2,
        fontWeight: FontWeight.w700,
        color: ink,
      ),
      titleMedium: TextStyle(
        fontSize: 18,
        height: 1.3,
        fontWeight: FontWeight.w600,
        color: ink,
      ),
      bodyLarge: TextStyle(fontSize: 16, height: 1.5, color: ink),
      bodyMedium: TextStyle(fontSize: 14, height: 1.5, color: muted),
      labelLarge: TextStyle(
        fontSize: 14,
        height: 1.2,
        fontWeight: FontWeight.w600,
        letterSpacing: 0.4,
        color: ink,
      ),
    );
  }
}

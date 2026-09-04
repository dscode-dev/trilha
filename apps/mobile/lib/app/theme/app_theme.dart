import 'package:flutter/material.dart';

import 'app_colors.dart';
import 'app_radius.dart';
import 'app_spacing.dart';
import 'app_typography.dart';

/// Assembles the Material 3 themes from the brand tokens (§21).
///
/// The tonal palette is seeded from the logo's green so that generated roles stay
/// harmonious, then the roles the brand actually owns — primary and surface — are
/// pinned to the sampled values. The result is neither a raw Material default nor
/// a palette that fights the logo.
abstract final class AppTheme {
  const AppTheme._();

  static ThemeData light() => _build(
    scheme:
        ColorScheme.fromSeed(
          seedColor: AppColors.brandGreen,
          brightness: Brightness.light,
        ).copyWith(
          primary: AppColors.brandGreen,
          onPrimary: Colors.white,
          surface: AppColors.surfaceLight,
          onSurface: AppColors.inkLight,
          error: AppColors.danger,
        ),
    ink: AppColors.inkLight,
  );

  static ThemeData dark() => _build(
    scheme:
        ColorScheme.fromSeed(
          seedColor: AppColors.brandGreen,
          brightness: Brightness.dark,
        ).copyWith(
          // The brand green does not clear 4.5:1 on a dark ground; the lighter
          // tint carries the brand without failing contrast (§23).
          primary: AppColors.brandGreenLight,
          onPrimary: const Color(0xFF00391A),
          surface: AppColors.surfaceDark,
          onSurface: AppColors.inkDark,
          error: AppColors.dangerDark,
        ),
    ink: AppColors.inkDark,
  );

  static ThemeData _build({required ColorScheme scheme, required Color ink}) {
    final TextTheme textTheme = AppTypography.textTheme(ink);

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: scheme.surface,
      fontFamily: AppTypography.fontFamily,
      textTheme: textTheme,
      appBarTheme: AppBarTheme(
        backgroundColor: scheme.surface,
        foregroundColor: scheme.onSurface,
        elevation: 0,
        scrolledUnderElevation: 1,
        centerTitle: false,
        titleTextStyle: textTheme.titleMedium,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          // Height, not just padding: the target must hold at large text sizes.
          minimumSize: const Size(64, AppSpacing.minTouchTarget),
          shape: const RoundedRectangleBorder(borderRadius: AppRadius.allMd),
          textStyle: textTheme.labelLarge,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          minimumSize: const Size(48, AppSpacing.minTouchTarget),
          shape: const RoundedRectangleBorder(borderRadius: AppRadius.allSm),
        ),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: scheme.surfaceContainerLow,
        shape: const RoundedRectangleBorder(borderRadius: AppRadius.allLg),
        margin: EdgeInsets.zero,
      ),
      dividerTheme: DividerThemeData(
        color: scheme.outlineVariant,
        space: 1,
        thickness: 1,
      ),
      snackBarTheme: const SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: AppRadius.allMd),
      ),
    );
  }
}

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/app/theme/app_colors.dart';
import 'package:trilha_mobile/app/theme/app_spacing.dart';
import 'package:trilha_mobile/app/theme/app_theme.dart';

/// WCAG 2.1 relative luminance.
double _luminance(Color color) {
  double channel(double component) => component <= 0.03928
      ? component / 12.92
      : math.pow((component + 0.055) / 1.055, 2.4) as double;

  return 0.2126 * channel(color.r) +
      0.7152 * channel(color.g) +
      0.0722 * channel(color.b);
}

double contrastRatio(Color a, Color b) {
  final double la = _luminance(a);
  final double lb = _luminance(b);
  return (math.max(la, lb) + 0.05) / (math.min(la, lb) + 0.05);
}

void main() {
  group('AppTheme', () {
    test('light theme adopts the brand green sampled from logo.png', () {
      expect(AppTheme.light().colorScheme.primary, AppColors.brandGreen);
    });

    test('light theme adopts the warm surface sampled from logo.png', () {
      expect(AppTheme.light().colorScheme.surface, AppColors.surfaceLight);
    });

    test('both themes use Material 3', () {
      expect(AppTheme.light().useMaterial3, isTrue);
      expect(AppTheme.dark().useMaterial3, isTrue);
    });

    test('themes declare the matching brightness', () {
      expect(AppTheme.light().colorScheme.brightness, Brightness.light);
      expect(AppTheme.dark().colorScheme.brightness, Brightness.dark);
    });

    test('scaffold background matches the scheme surface', () {
      expect(
        AppTheme.light().scaffoldBackgroundColor,
        AppTheme.light().colorScheme.surface,
      );
      expect(
        AppTheme.dark().scaffoldBackgroundColor,
        AppTheme.dark().colorScheme.surface,
      );
    });

    group('accessibility (§23)', () {
      test('body text clears WCAG AA on both themes', () {
        for (final ThemeData theme in <ThemeData>[
          AppTheme.light(),
          AppTheme.dark(),
        ]) {
          final ColorScheme scheme = theme.colorScheme;
          expect(
            contrastRatio(scheme.onSurface, scheme.surface),
            greaterThanOrEqualTo(4.5),
            reason: '${scheme.brightness.name}: onSurface vs surface',
          );
        }
      });

      test('text on primary clears WCAG AA on both themes', () {
        for (final ThemeData theme in <ThemeData>[
          AppTheme.light(),
          AppTheme.dark(),
        ]) {
          final ColorScheme scheme = theme.colorScheme;
          expect(
            contrastRatio(scheme.onPrimary, scheme.primary),
            greaterThanOrEqualTo(4.5),
            reason: '${scheme.brightness.name}: onPrimary vs primary',
          );
        }
      });

      test('error colour is distinguishable from the surface', () {
        for (final ThemeData theme in <ThemeData>[
          AppTheme.light(),
          AppTheme.dark(),
        ]) {
          final ColorScheme scheme = theme.colorScheme;
          expect(
            contrastRatio(scheme.error, scheme.surface),
            greaterThanOrEqualTo(3.0),
          );
        }
      });

      test('buttons meet the minimum touch target', () {
        final Size? minimumSize = AppTheme.light()
            .filledButtonTheme
            .style
            ?.minimumSize
            ?.resolve(<WidgetState>{});

        expect(
          minimumSize?.height,
          greaterThanOrEqualTo(AppSpacing.minTouchTarget),
        );
      });
    });
  });
}

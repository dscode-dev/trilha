import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';

/// Icon and tint per category (§46, §58).
///
/// Category is conveyed by an icon as well as a colour, so the distinction survives
/// for a colour-blind user and in greyscale. One icon per category keeps the asset
/// count at zero — these are Material glyphs, not bespoke artwork.
abstract final class PlaceCategoryVisuals {
  const PlaceCategoryVisuals._();

  static IconData iconFor(String categoryId) => switch (categoryId) {
    'FOOD' => Icons.restaurant,
    'NATURE' => Icons.park,
    'HISTORY_CULTURE' => Icons.museum,
    'LEISURE' => Icons.sports_soccer,
    'SHOPPING' => Icons.shopping_bag,
    'LANDMARK' => Icons.location_city,
    'ACCOMMODATION' => Icons.hotel,
    'SERVICE' => Icons.build,
    _ => Icons.place,
  };

  /// Tints stay within the brand's green family rather than introducing a second
  /// palette; the icon carries the meaning.
  static Color colorFor(String categoryId, ColorScheme scheme) =>
      switch (categoryId) {
        'FOOD' => const Color(0xFFB4611C),
        'NATURE' => AppColors.brandGreen,
        'HISTORY_CULTURE' => const Color(0xFF6A4C93),
        'LEISURE' => const Color(0xFF1F7A8C),
        'SHOPPING' => const Color(0xFFA63A63),
        'LANDMARK' => AppColors.brandGreenDark,
        'ACCOMMODATION' => const Color(0xFF3D5A80),
        'SERVICE' => const Color(0xFF5C6672),
        _ => scheme.onSurfaceVariant,
      };

  /// Human label used when the server vocabulary has not loaded yet.
  static String fallbackLabel(String categoryId) => switch (categoryId) {
    'FOOD' => 'Food & drink',
    'NATURE' => 'Nature',
    'HISTORY_CULTURE' => 'History & culture',
    'LEISURE' => 'Leisure',
    'SHOPPING' => 'Shopping',
    'LANDMARK' => 'Landmark',
    'ACCOMMODATION' => 'Accommodation',
    'SERVICE' => 'Services',
    _ => 'Other',
  };
}

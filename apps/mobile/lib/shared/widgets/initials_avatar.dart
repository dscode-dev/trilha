import 'package:flutter/material.dart';

/// Placeholder avatar derived from the account's name (§43).
///
/// V1 has no avatar upload, so rather than showing a generic silhouette the initials
/// give each account something recognisable. The hue is derived from a stable seed,
/// so a person's avatar does not change colour between launches.
class InitialsAvatar extends StatelessWidget {
  const InitialsAvatar({
    required this.initials,
    required this.seed,
    this.radius = 32,
    super.key,
  });

  final String initials;

  /// Stable per account — the username, in practice.
  final String seed;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final ColorScheme colors = Theme.of(context).colorScheme;
    final Color background = _tint(colors);

    return Semantics(
      // The initials alone would be read as meaningless letters.
      label: 'Profile picture',
      excludeSemantics: true,
      child: CircleAvatar(
        radius: radius,
        backgroundColor: background,
        child: Text(
          initials,
          style: TextStyle(
            fontSize: radius * 0.7,
            fontWeight: FontWeight.w600,
            // Contrast is guaranteed by pairing with the scheme's `onX` role rather
            // than by hoping the generated hue is dark enough (§23).
            color: colors.onPrimaryContainer,
          ),
        ),
      ),
    );
  }

  Color _tint(ColorScheme colors) {
    if (seed.isEmpty) return colors.primaryContainer;

    final int hash = seed.codeUnits.fold<int>(
      0,
      (int acc, int unit) => (acc * 31 + unit) & 0xFFFFF,
    );
    // Rotate the brand container hue rather than inventing an arbitrary colour, so
    // avatars stay within the palette.
    return HSLColor.fromColor(colors.primaryContainer)
        .withHue((hash % 360).toDouble())
        .toColor();
  }
}

import 'package:flutter/material.dart';

/// Renders the Trilha mark from the bundled brand asset.
///
/// Centralised so that the logo is loaded from exactly one place; when the asset is
/// replaced (or gains a dark variant) no screen needs to change. The image carries a
/// semantic label rather than being hidden, because it is the app's identity (§23).
class TrilhaLogo extends StatelessWidget {
  const TrilhaLogo({super.key, this.size = 160, this.semanticLabel = 'Trilha'});

  static const String assetPath = 'assets/brand/logo.png';

  final double size;
  final String semanticLabel;

  @override
  Widget build(BuildContext context) {
    return Image.asset(
      assetPath,
      width: size,
      height: size,
      // The mark must never be cropped or stretched.
      fit: BoxFit.contain,
      semanticLabel: semanticLabel,
      // A missing asset is a build error, not something to hide from a developer.
      errorBuilder: (context, error, stackTrace) => SizedBox(
        width: size,
        height: size,
        child: Icon(
          Icons.broken_image_outlined,
          size: size / 2,
          color: Theme.of(context).colorScheme.error,
        ),
      ),
    );
  }
}

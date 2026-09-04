import 'package:flutter/material.dart';

import '../../../app/theme/app_spacing.dart';
import '../../../shared/widgets/trilha_logo.dart';

/// Shown when no Mapbox token was supplied at build time (§37, §86).
///
/// A blank rectangle would look like a bug in Trilha; this says exactly what is
/// missing and how to supply it, which is what a developer hitting this needs.
class MapUnavailable extends StatelessWidget {
  const MapUnavailable({super.key});

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  const TrilhaLogo(size: 96),
                  const SizedBox(height: AppSpacing.lg),
                  Semantics(
                    header: true,
                    child: Text(
                      'The map needs a Mapbox token',
                      style: theme.textTheme.titleMedium,
                      textAlign: TextAlign.center,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.sm),
                  Text(
                    'Run the app with a public Mapbox access token:\n\n'
                    'flutter run --dart-define=MAPBOX_ACCESS_TOKEN=pk.…',
                    style: theme.textTheme.bodyMedium,
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

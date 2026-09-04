import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_spacing.dart';
import '../../../core/errors/app_failure.dart';
import '../application/places_providers.dart';
import '../domain/place.dart';
import 'place_category_visuals.dart';

/// Detail for a selected Place (§48, §49).
///
/// Shows what Trilha actually knows: name, category, description, where the record
/// came from, and — when the device has offered a position this session — how far
/// away it is. There is no rating, no safety indicator and no opening hours, because
/// none of those exist yet and a placeholder for them would be a claim, not a gap.
class PlaceDetailSheet extends ConsumerWidget {
  const PlaceDetailSheet({
    required this.placeId,
    this.knownDistanceMetres,
    super.key,
  });

  final String placeId;

  /// Distance as computed by PostGIS, when the sheet was opened from a result that
  /// carried one. Not recomputed on the device: the server's spheroid distance is
  /// the authoritative number, and a local approximation would disagree with it.
  final int? knownDistanceMetres;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<PlaceDetail> detail = ref.watch(
      placeDetailProvider(placeId),
    );

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.lg,
          0,
          AppSpacing.lg,
          AppSpacing.lg,
        ),
        child: detail.when(
          loading: () => const Padding(
            padding: EdgeInsets.all(AppSpacing.xl),
            child: Center(child: CircularProgressIndicator()),
          ),
          error: (Object error, _) =>
              _SheetError(failure: AppFailure.from(error)),
          data: (PlaceDetail place) =>
              _PlaceBody(place: place, distanceMetres: knownDistanceMetres),
        ),
      ),
    );
  }
}

class _PlaceBody extends StatelessWidget {
  const _PlaceBody({required this.place, this.distanceMetres});

  final PlaceDetail place;
  final int? distanceMetres;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            CircleAvatar(
              backgroundColor: PlaceCategoryVisuals.colorFor(
                place.categoryId,
                theme.colorScheme,
              ).withValues(alpha: 0.15),
              child: Icon(
                PlaceCategoryVisuals.iconFor(place.categoryId),
                color: PlaceCategoryVisuals.colorFor(
                  place.categoryId,
                  theme.colorScheme,
                ),
              ),
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Semantics(
                    header: true,
                    child: Text(place.name, style: theme.textTheme.titleMedium),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    PlaceCategoryVisuals.fallbackLabel(place.categoryId),
                    style: theme.textTheme.bodyMedium,
                  ),
                ],
              ),
            ),
          ],
        ),

        if (place.description != null &&
            place.description!.isNotEmpty) ...<Widget>[
          const SizedBox(height: AppSpacing.md),
          Text(place.description!, style: theme.textTheme.bodyLarge),
        ],

        const SizedBox(height: AppSpacing.md),
        const Divider(),
        const SizedBox(height: AppSpacing.sm),

        /* Only when a proximity query supplied it. Nothing is measured on the
           device and no position is stored to make this appear (§42). */
        if (distanceMetres != null)
          _DetailRow(
            icon: Icons.straighten,
            label: '${formatDistance(distanceMetres!)} away',
          ),

        _DetailRow(icon: Icons.info_outline, label: place.provenance.label),

        if (place.contributor != null)
          _DetailRow(
            icon: Icons.person_outline,
            label: 'Contributed by ${place.contributor!.displayName}',
          ),
      ],
    );
  }
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
      child: Row(
        children: <Widget>[
          Icon(icon, size: 18, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(width: AppSpacing.sm),
          Expanded(child: Text(label, style: theme.textTheme.bodyMedium)),
        ],
      ),
    );
  }
}

class _SheetError extends StatelessWidget {
  const _SheetError({required this.failure});

  final AppFailure failure;

  @override
  Widget build(BuildContext context) {
    final String message = switch (failure.kind) {
      FailureKind.networkUnavailable =>
        'No connection. Check your network and try again.',
      _ => 'Could not load this place.',
    };

    return Padding(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Row(
        children: <Widget>[
          Icon(Icons.error_outline, color: Theme.of(context).colorScheme.error),
          const SizedBox(width: AppSpacing.sm),
          Expanded(child: Text(message)),
        ],
      ),
    );
  }
}

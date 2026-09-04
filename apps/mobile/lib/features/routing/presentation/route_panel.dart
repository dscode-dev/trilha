import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_radius.dart';
import '../../../app/theme/app_spacing.dart';
import '../../../core/errors/app_failure.dart';
import '../../places/domain/place.dart';
import '../application/routing_controller.dart';
import '../application/routing_providers.dart';
import '../application/routing_state.dart';
import '../domain/route.dart';

/// The route-building surface (§32, §39).
///
/// A floating panel over the map rather than a screen of its own: the map is what the
/// user is reasoning about, and pushing it off-screen to fill in two fields would
/// break that. Compact by design — distance and duration and nothing else. No cost,
/// no tolls, no fuel, no stops, no safety: none of those exist in the product yet.
class RoutePanel extends ConsumerWidget {
  const RoutePanel({
    required this.onPickOrigin,
    required this.onPickDestination,
    super.key,
  });

  /// Opens whatever selection affordance the host provides — search or map pick.
  final VoidCallback onPickOrigin;
  final VoidCallback onPickDestination;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final RoutingState state = ref.watch(routingControllerProvider);
    final RoutingController controller = ref.read(
      routingControllerProvider.notifier,
    );
    final ThemeData theme = Theme.of(context);

    return Material(
      elevation: 4,
      borderRadius: AppRadius.allMd,
      color: theme.colorScheme.surface,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              children: <Widget>[
                Expanded(
                  child: Column(
                    children: <Widget>[
                      _EndpointField(
                        marker: 'A',
                        hint: 'Choose a starting point',
                        endpoint: state.origin,
                        enabled: !state.isLoading,
                        onTap: onPickOrigin,
                      ),
                      const SizedBox(height: AppSpacing.sm),
                      _EndpointField(
                        marker: 'B',
                        hint: 'Choose a destination',
                        endpoint: state.destination,
                        enabled: !state.isLoading,
                        onTap: onPickDestination,
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                IconButton(
                  icon: const Icon(Icons.swap_vert),
                  tooltip: 'Swap start and destination',
                  onPressed: state.hasBothEndpoints && !state.isLoading
                      ? controller.swap
                      : null,
                ),
              ],
            ),

            if (state.routeOrNull != null) ...<Widget>[
              const SizedBox(height: AppSpacing.md),
              _RouteSummary(route: state.routeOrNull!),
            ],

            if (state.failureOrNull != null) ...<Widget>[
              const SizedBox(height: AppSpacing.sm),
              _RouteError(failure: state.failureOrNull!),
            ],

            const SizedBox(height: AppSpacing.md),
            Row(
              children: <Widget>[
                if (state.isActive)
                  TextButton(
                    onPressed: state.isLoading ? null : controller.reset,
                    child: const Text('Clear'),
                  ),
                const Spacer(),
                FilledButton.icon(
                  onPressed: state.canCalculate && !state.isLoading
                      ? () => unawaited(controller.calculate())
                      : null,
                  icon: state.isLoading
                      ? const SizedBox(
                          height: 16,
                          width: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.directions),
                  label: Text(
                    state.routeOrNull == null ? 'Get route' : 'Recalculate',
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// One endpoint slot, showing what is chosen or inviting a choice.
class _EndpointField extends StatelessWidget {
  const _EndpointField({
    required this.marker,
    required this.hint,
    required this.endpoint,
    required this.enabled,
    required this.onTap,
  });

  final String marker;
  final String hint;
  final RouteEndpoint? endpoint;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final RouteEndpoint? value = endpoint;

    return InkWell(
      onTap: enabled ? onTap : null,
      borderRadius: AppRadius.allSm,
      child: Semantics(
        button: true,
        label: value == null
            ? '$hint, point $marker'
            : 'Point $marker: ${value.label ?? _describe(value.position)}',
        child: Container(
          constraints: const BoxConstraints(
            minHeight: AppSpacing.minTouchTarget,
          ),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
          child: Row(
            children: <Widget>[
              /* A letter, not a coloured dot: the distinction has to survive for a
                 colour-blind user, and it must not read as a Place marker (§38). */
              CircleAvatar(
                radius: 12,
                backgroundColor: theme.colorScheme.primary,
                child: Text(
                  marker,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: theme.colorScheme.onPrimary,
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(
                  value == null
                      ? hint
                      : (value.label ?? _describe(value.position)),
                  style: value == null
                      ? theme.textTheme.bodyMedium
                      : theme.textTheme.bodyLarge,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Coordinates, when a point was tapped rather than named.
  static String _describe(LatLng position) =>
      '${position.latitude.toStringAsFixed(4)}, ${position.longitude.toStringAsFixed(4)}';
}

class _RouteSummary extends StatelessWidget {
  const _RouteSummary({required this.route});

  final TrilhaRoute route;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String distance = formatRouteDistance(route.distanceMeters);
    final String duration = formatDuration(route.durationSeconds);

    return Semantics(
      liveRegion: true,
      label: 'Route: $distance, about $duration',
      excludeSemantics: true,
      child: Row(
        children: <Widget>[
          Icon(
            Icons.straighten,
            size: 18,
            color: theme.colorScheme.onSurfaceVariant,
          ),
          const SizedBox(width: AppSpacing.xs),
          Text(distance, style: theme.textTheme.titleMedium),
          Text('  ·  ', style: theme.textTheme.titleMedium),
          Icon(
            Icons.schedule,
            size: 18,
            color: theme.colorScheme.onSurfaceVariant,
          ),
          const SizedBox(width: AppSpacing.xs),
          Text(duration, style: theme.textTheme.titleMedium),
        ],
      ),
    );
  }
}

class _RouteError extends StatelessWidget {
  const _RouteError({required this.failure});

  final AppFailure failure;

  @override
  Widget build(BuildContext context) {
    final ColorScheme colors = Theme.of(context).colorScheme;

    return Semantics(
      liveRegion: true,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(Icons.error_outline, size: 18, color: colors.error),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              routeFailureMessage(failure),
              style: Theme.of(context).textTheme.bodyMedium
                  ?.copyWith(color: colors.error),
            ),
          ),
        ],
      ),
    );
  }
}

/// Turns a failure into words (§56).
///
/// Screens never render a status code or an exception type.
String routeFailureMessage(AppFailure failure) => switch (failure.kind) {
  FailureKind.networkUnavailable =>
    'No connection. Check your network and try again.',
  FailureKind.sessionExpired =>
    'Your session ended. Sign in again to get routes.',
  FailureKind.rateLimited => 'Too many route requests. Please wait a moment.',
  FailureKind.notRoutable => 'No driving route connects those two points.',
  FailureKind.validation =>
    'Those two points are too close together to route between.',
  FailureKind.providerUnavailable =>
    'Routing is unavailable right now. Please try again shortly.',
  _ => 'Could not calculate that route. Please try again.',
};

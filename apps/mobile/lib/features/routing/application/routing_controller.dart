import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/logging/app_logger.dart';
import '../../places/application/places_providers.dart';
import '../../places/domain/place.dart';
import '../data/routing_api.dart';
import '../domain/route.dart';
import 'routing_providers.dart';
import 'routing_state.dart';

/// Drives route creation (§35, §42, §43, §44).
///
/// Widgets report intent here and read state back; nothing in the presentation layer
/// talks to the API or to Mapbox.
class RoutingController extends Notifier<RoutingState> {
  RoutingEndpoints get _api => ref.read(routingApiProvider);
  AppLogger get _logger => ref.read(routingLoggerProvider);

  CancelToken? _inFlight;

  /// Identifies the newest calculation, so a slow earlier one cannot draw over it.
  int _requestSequence = 0;

  @override
  RoutingState build() {
    ref.onDispose(() => _inFlight?.cancel('routing controller disposed'));
    return const RoutingIdle();
  }

  void setOrigin(RouteEndpoint origin) {
    /* Changing an endpoint invalidates any route already drawn: leaving the old line
       on screen beside a new pin would show a journey nobody asked for (§43). */
    _cancelInFlight();
    state = _afterSelection(origin: origin, destination: state.destination);
  }

  void setDestination(RouteEndpoint destination) {
    _cancelInFlight();
    state = _afterSelection(origin: state.origin, destination: destination);
  }

  /// Uses the device's position as the origin, if one is available (§33).
  ///
  /// Returns false when location is unavailable — the caller explains why, and route
  /// building stays possible by picking a point instead.
  Future<bool> useCurrentLocationAsOrigin() async {
    final LatLng? position = await ref
        .read(mapControllerProvider.notifier)
        .locateMe();
    if (position == null || !ref.mounted) return false;

    setOrigin(RouteEndpoint(position: position, label: 'Your location'));
    return true;
  }

  /// Exchanges the endpoints without recalculating (§40).
  ///
  /// Swapping is a change of intent, not a request: the user asks for the new route
  /// explicitly, the same as after any other edit.
  void swap() {
    final RouteEndpoint? origin = state.origin;
    final RouteEndpoint? destination = state.destination;
    if (origin == null || destination == null) return;

    _cancelInFlight();
    state = RoutingReady(origin: destination, destination: origin);
  }

  /// Clears everything routing owns, and nothing else (§41).
  void reset() {
    _cancelInFlight();
    state = const RoutingIdle();
  }

  /// Requests the route. Only ever called because the user asked (§35).
  Future<void> calculate() async {
    final RouteEndpoint? origin = state.origin;
    final RouteEndpoint? destination = state.destination;
    if (origin == null || destination == null) return;

    _inFlight?.cancel('superseded by a newer route request');
    final CancelToken cancelToken = CancelToken();
    _inFlight = cancelToken;

    final int sequence = ++_requestSequence;
    state = RoutingLoading(origin: origin, destination: destination);

    try {
      final TrilhaRoute route = await _api.calculate(
        origin: origin,
        destination: destination,
        cancelToken: cancelToken,
      );

      /* A response for a request the user has already replaced is discarded rather
         than drawn (§43). */
      if (!ref.mounted || sequence != _requestSequence) return;

      state = RoutingSuccess(
        route: route,
        origin: origin,
        destination: destination,
      );

      /* Distance and duration are safe to record; the endpoints are not — a route
         request is a statement about where someone is going (§58). */
      _logger.info(
        'Route calculated',
        context: <String, Object?>{
          'distanceMeters': route.distanceMeters,
          'durationSeconds': route.durationSeconds,
          'points': route.geometry.length,
        },
      );
    } on AppFailure catch (failure) {
      if (!ref.mounted || sequence != _requestSequence) return;
      if (failure.kind == FailureKind.cancelled) return;

      _logger.warning(
        'Route calculation failed',
        context: <String, Object?>{'kind': failure.kind.name},
      );
      state = RoutingFailure(
        failure: failure,
        origin: origin,
        destination: destination,
      );
    }
  }

  void _cancelInFlight() {
    _inFlight?.cancel('route inputs changed');
    _inFlight = null;
    /* Bumped so any response still in flight is recognised as stale. */
    _requestSequence += 1;
  }

  static RoutingState _afterSelection({
    RouteEndpoint? origin,
    RouteEndpoint? destination,
  }) {
    if (origin != null && destination != null) {
      return RoutingReady(origin: origin, destination: destination);
    }
    if (origin != null || destination != null) {
      return RoutingSelecting(origin: origin, destination: destination);
    }
    return const RoutingIdle();
  }
}

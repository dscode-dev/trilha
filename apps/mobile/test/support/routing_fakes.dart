import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:trilha_mobile/app/bootstrap/providers.dart';
import 'package:trilha_mobile/app/config/app_config.dart';
import 'package:trilha_mobile/app/config/app_environment.dart';
import 'package:trilha_mobile/core/errors/app_failure.dart';
import 'package:trilha_mobile/core/logging/app_logger.dart';
import 'package:trilha_mobile/core/observability/error_reporter.dart';
import 'package:trilha_mobile/features/auth/application/auth_providers.dart';
import 'package:trilha_mobile/features/places/application/places_providers.dart';
import 'package:trilha_mobile/features/places/domain/place.dart';
import 'package:trilha_mobile/features/routing/data/routing_api.dart';
import 'package:trilha_mobile/features/routing/application/routing_providers.dart';
import 'package:trilha_mobile/features/routing/domain/route.dart';

import 'auth_fakes.dart';
import 'places_fakes.dart';

/// Recife → Olinda, far enough apart to be a real route.
const LatLng kOlinda = LatLng(latitude: -7.9939, longitude: -34.8455);

RouteEndpoint originEndpoint() =>
    const RouteEndpoint(position: kMarcoZero, label: 'Marco Zero');

RouteEndpoint destinationEndpoint() => const RouteEndpoint(
  position: kOlinda,
  placeId: 'olinda-id',
  label: 'Olinda',
);

/// A plausible route, shaped exactly as the API layer would produce one.
TrilhaRoute sampleRoute({
  RouteEndpoint? origin,
  RouteEndpoint? destination,
  int distanceMeters = 121000,
  int durationSeconds = 6480,
}) {
  final RouteEndpoint from = origin ?? originEndpoint();
  final RouteEndpoint to = destination ?? destinationEndpoint();

  return TrilhaRoute(
    origin: from,
    destination: to,
    geometry: <LatLng>[from.position, kIgrejaDaSe, to.position],
    distanceMeters: distanceMeters,
    durationSeconds: durationSeconds,
    bounds: MapBounds(
      north: to.position.latitude,
      south: from.position.latitude,
      east: to.position.longitude,
      west: from.position.longitude,
    ),
    legs: <RouteLeg>[
      RouteLeg(
        distanceMeters: distanceMeters,
        durationSeconds: durationSeconds,
      ),
    ],
  );
}

/// Scriptable stand-in for the routing HTTP boundary (§66).
///
/// Records every request so tests can assert *how many* calls a gesture produced —
/// the point of the "nothing is requested until the user asks" rule (§35).
class FakeRoutingApi implements RoutingEndpoints {
  TrilhaRoute? result;
  AppFailure? failure;

  /// Applied to every call, so a test can observe the loading state and race two
  /// requests against each other.
  Duration latency = Duration.zero;

  /// Per-call latency, consumed in order, falling back to [latency]. Lets a test
  /// make the *first* request slower than the second.
  final List<Duration> latencies = <Duration>[];

  int calls = 0;
  final List<({RouteEndpoint origin, RouteEndpoint destination})> requests =
      <({RouteEndpoint origin, RouteEndpoint destination})>[];

  @override
  Future<TrilhaRoute> calculate({
    required RouteEndpoint origin,
    required RouteEndpoint destination,
    CancelToken? cancelToken,
  }) async {
    final int index = calls;
    calls += 1;
    requests.add((origin: origin, destination: destination));

    final Duration wait = index < latencies.length ? latencies[index] : latency;
    if (wait > Duration.zero) await Future<void>.delayed(wait);

    if (cancelToken?.isCancelled ?? false) {
      throw const AppFailure(
        kind: FailureKind.cancelled,
        message: 'Request cancelled.',
      );
    }

    final AppFailure? thrown = failure;
    if (thrown != null) throw thrown;

    return result ?? sampleRoute(origin: origin, destination: destination);
  }
}

/// A container wired to fakes for auth, places and routing.
///
/// Routing reuses the Places container's dependencies because the controller reads
/// the device position through the map controller (§33). Written out as a literal
/// for the same reason [placesTestContainer] is: `Override` is not exported.
ProviderContainer routingTestContainer({
  FakeRoutingApi? routing,
  FakePlacesApi? places,
  FakeLocationService? location,
}) {
  return ProviderContainer(
    overrides: [
      appConfigProvider.overrideWithValue(
        AppConfig.forEnvironment(AppEnvironment.development),
      ),
      appLoggerProvider.overrideWithValue(const AppLogger(name: 'test')),
      errorReporterProvider.overrideWithValue(
        const LoggingErrorReporter(AppLogger(name: 'test')),
      ),
      authApiProvider.overrideWithValue(FakeAuthApi()),
      tokenStoreProvider.overrideWithValue(FakeTokenStore()),
      placesApiProvider.overrideWithValue(places ?? FakePlacesApi()),
      locationServiceProvider.overrideWithValue(
        location ?? FakeLocationService(),
      ),
      routingApiProvider.overrideWithValue(routing ?? FakeRoutingApi()),
    ],
  );
}

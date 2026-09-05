import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:trilha_mobile/app/bootstrap/providers.dart';
import 'package:trilha_mobile/app/config/app_config.dart';
import 'package:trilha_mobile/app/config/app_environment.dart';
import 'package:trilha_mobile/core/errors/app_failure.dart';
import 'package:trilha_mobile/core/logging/app_logger.dart';
import 'package:trilha_mobile/core/observability/error_reporter.dart';
import 'package:trilha_mobile/features/auth/application/auth_providers.dart';
import 'package:trilha_mobile/features/discovery/application/discovery_providers.dart';
import 'package:trilha_mobile/features/discovery/data/discovery_api.dart';
import 'package:trilha_mobile/features/discovery/domain/route_candidate.dart';
import 'package:trilha_mobile/features/places/application/places_providers.dart';
import 'package:trilha_mobile/features/places/domain/place.dart';
import 'package:trilha_mobile/features/routing/application/routing_providers.dart';
import 'package:trilha_mobile/features/routing/domain/route.dart';

import 'auth_fakes.dart';
import 'places_fakes.dart';
import 'routing_fakes.dart';

/// A candidate with plausible values, distinct per call.
int _candidateCounter = 0;

RouteCandidate candidate({
  String? id,
  String name = 'Mirante do Alto da Sé',
  String categoryId = 'NATURE',
  int detourSeconds = 420,
  int distanceFromRouteMeters = 1_200,
  double routeProgress = 0.42,
  double relevanceScore = 0.91,
  List<RelevanceReason> reasons = const <RelevanceReason>[
    RelevanceReason.veryCloseToRoute,
    RelevanceReason.lowDetour,
    RelevanceReason.goodRoutePosition,
  ],
}) {
  _candidateCounter += 1;

  return RouteCandidate(
    place: CandidatePlace(
      id: id ?? 'candidate-$_candidateCounter',
      name: name,
      categoryId: categoryId,
      position: LatLng(
        latitude: -7.85 + _candidateCounter * 0.001,
        longitude: -34.85,
      ),
    ),
    distanceFromRouteMeters: distanceFromRouteMeters,
    detourDistanceMeters: detourSeconds * 15,
    detourDurationSeconds: detourSeconds,
    routeProgress: routeProgress,
    relevanceScore: relevanceScore,
    relevanceReasons: reasons,
  );
}

/// Scriptable stand-in for the discovery HTTP boundary (§75).
///
/// Records every request so tests can assert *how many* a gesture produced — the
/// point of the "only on an explicit action" rule (§65).
class FakeDiscoveryApi implements DiscoveryEndpoints {
  List<RouteCandidate> results = <RouteCandidate>[];
  String policyVersion = 'v1';
  AppFailure? failure;

  /// Applied to every call, so a test can observe loading and race two requests.
  Duration latency = Duration.zero;

  /// Per-call latency, consumed in order, falling back to [latency].
  final List<Duration> latencies = <Duration>[];

  int calls = 0;
  final List<List<String>> categoriesRequested = <List<String>>[];
  final List<RouteEndpoint> originsRequested = <RouteEndpoint>[];

  @override
  Future<DiscoveryResult> discover({
    required RouteEndpoint origin,
    required RouteEndpoint destination,
    required List<String> categories,
    int? maxDetourMinutes,
    CancelToken? cancelToken,
  }) async {
    final int index = calls;
    calls += 1;
    categoriesRequested.add(categories);
    originsRequested.add(origin);

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

    return DiscoveryResult(candidates: results, policyVersion: policyVersion);
  }
}

/// A container wired to fakes for auth, places, routing and discovery.
///
/// Written out as a literal for the same reason the others are: `Override` is not
/// exported by `flutter_riverpod`, so a list cannot cross a function boundary.
ProviderContainer discoveryTestContainer({
  FakeDiscoveryApi? discovery,
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
      discoveryApiProvider.overrideWithValue(discovery ?? FakeDiscoveryApi()),
    ],
  );
}

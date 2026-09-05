import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:trilha_mobile/app/bootstrap/providers.dart';
import 'package:trilha_mobile/app/config/app_config.dart';
import 'package:trilha_mobile/app/config/app_environment.dart';
import 'package:trilha_mobile/core/errors/app_failure.dart';
import 'package:trilha_mobile/core/logging/app_logger.dart';
import 'package:trilha_mobile/core/observability/error_reporter.dart';
import 'package:trilha_mobile/features/auth/application/auth_providers.dart';
import 'package:trilha_mobile/features/discovery/application/discovery_providers.dart';
import 'package:trilha_mobile/features/places/application/places_providers.dart';
import 'package:trilha_mobile/features/places/domain/place.dart';
import 'package:trilha_mobile/features/routing/application/routing_providers.dart';
import 'package:trilha_mobile/features/trails/application/trail_providers.dart';
import 'package:trilha_mobile/features/trails/data/trails_api.dart';
import 'package:trilha_mobile/features/trails/domain/trail.dart';

import 'auth_fakes.dart';
import 'discovery_fakes.dart';
import 'places_fakes.dart';
import 'routing_fakes.dart';

/// A trail as the server would return it.
Trail trailFixture({
  String id = 'trail-1',
  TrailStatus status = TrailStatus.draft,
  List<TrailStop> stops = const <TrailStop>[],
  int revision = 1,
  bool routeIsCurrent = true,
  int maxStops = 15,
  int distanceMeters = 145_000,
  int durationSeconds = 7_860,
  TrailMetrics? detour,
  bool withRoute = true,
}) => Trail(
  id: id,
  status: status,
  origin: const TrailEndpoint(position: kMarcoZero, label: 'Recife'),
  destination: const TrailEndpoint(position: kOlinda, label: 'João Pessoa'),
  stops: stops,
  revision: revision,
  route: withRoute
      ? TrailRoute(
          geometry: const <LatLng>[kMarcoZero, kIgrejaDaSe, kOlinda],
          bounds: const MapBounds(
            north: -7.9939,
            south: -8.0631,
            east: -34.8455,
            west: -34.8711,
          ),
          distanceMeters: distanceMeters,
          durationSeconds: durationSeconds,
        )
      : null,
  baseRoute: withRoute
      ? const TrailMetrics(distanceMeters: 121_000, durationSeconds: 6_480)
      : null,
  detour: detour,
  routeIsCurrent: routeIsCurrent,
  maxStops: maxStops,
  updatedAt: DateTime.utc(2026, 9, 5),
);

int _stopCounter = 0;

TrailStop stopFixture({
  String? id,
  String? placeId,
  int position = 1,
  String name = 'Mirante',
  TrailStopSource source = TrailStopSource.discovery,
}) {
  _stopCounter += 1;

  return TrailStop(
    id: id ?? 'stop-$_stopCounter',
    placeId: placeId ?? 'place-$_stopCounter',
    position: position,
    source: source,
    placeName: name,
    placeCategoryId: 'LANDMARK',
    location: LatLng(latitude: -7.85 + position * 0.01, longitude: -34.85),
  );
}

/// A trail with [count] stops, numbered from 1.
Trail trailWithStops(int count, {int revision = 1, String idPrefix = 'stop'}) =>
    trailFixture(
      revision: revision,
      stops: <TrailStop>[
        for (int i = 1; i <= count; i += 1)
          stopFixture(
            id: '$idPrefix-$i',
            placeId: 'place-$i',
            position: i,
            name: 'Parada $i',
          ),
      ],
    );

/// Scriptable stand-in for the trail HTTP boundary (§94).
///
/// Records every call so a test can assert *how many* requests a gesture produced —
/// which is the whole point of the one-mutation-per-drag rule (§55, §95).
class FakeTrailsApi implements TrailEndpoints {
  Trail? result;
  List<TrailSummary> listResult = <TrailSummary>[];
  String? nextCursor;
  AppFailure? failure;

  /// Applied to every call, so a test can observe an in-flight state.
  Duration latency = Duration.zero;

  /// Holds every call open until completed, with no timer involved.
  ///
  /// A widget test that leaves a real `Future.delayed` pending fails at teardown, and
  /// pumping the clock far enough to clear it makes the test about timing rather than
  /// about the state it is checking. A completer gives the same observation window
  /// and finishes exactly when the test says so.
  Completer<void>? gate;

  int createCalls = 0;
  int readCalls = 0;
  int listCalls = 0;
  int addStopCalls = 0;
  int removeStopCalls = 0;
  int reorderCalls = 0;
  int recalculateCalls = 0;
  int finalizeCalls = 0;

  final List<String> addedPlaceIds = <String>[];
  final List<TrailStopSource> addedSources = <TrailStopSource>[];
  final List<List<String>> reorderedOrders = <List<String>>[];
  final List<int> revisionsSent = <int>[];
  final List<String?> cursorsRequested = <String?>[];

  Future<Trail> _respond() async {
    await gate?.future;
    if (latency > Duration.zero) await Future<void>.delayed(latency);

    final AppFailure? thrown = failure;
    if (thrown != null) throw thrown;

    return result ?? trailFixture();
  }

  @override
  Future<Trail> create({
    required TrailEndpoint origin,
    required TrailEndpoint destination,
  }) {
    createCalls += 1;
    return _respond();
  }

  @override
  Future<Trail> byId(String trailId) {
    readCalls += 1;
    return _respond();
  }

  @override
  Future<TrailPage> list({String? cursor, int limit = 20}) async {
    listCalls += 1;
    cursorsRequested.add(cursor);
    if (latency > Duration.zero) await Future<void>.delayed(latency);

    final AppFailure? thrown = failure;
    if (thrown != null) throw thrown;

    return TrailPage(trails: listResult, nextCursor: nextCursor);
  }

  @override
  Future<Trail> addStop({
    required String trailId,
    required String placeId,
    required TrailStopSource source,
    required int expectedRevision,
  }) {
    addStopCalls += 1;
    addedPlaceIds.add(placeId);
    addedSources.add(source);
    revisionsSent.add(expectedRevision);
    return _respond();
  }

  @override
  Future<Trail> removeStop({
    required String trailId,
    required String stopId,
    required int expectedRevision,
  }) {
    removeStopCalls += 1;
    revisionsSent.add(expectedRevision);
    return _respond();
  }

  @override
  Future<Trail> reorderStops({
    required String trailId,
    required List<String> stopIds,
    required int expectedRevision,
  }) {
    reorderCalls += 1;
    reorderedOrders.add(stopIds);
    revisionsSent.add(expectedRevision);
    return _respond();
  }

  @override
  Future<Trail> recalculate({
    required String trailId,
    required int expectedRevision,
  }) {
    recalculateCalls += 1;
    revisionsSent.add(expectedRevision);
    return _respond();
  }

  @override
  Future<Trail> finalize({
    required String trailId,
    required int expectedRevision,
  }) {
    finalizeCalls += 1;
    revisionsSent.add(expectedRevision);
    return _respond();
  }

  @override
  Future<void> delete(String trailId) async {
    if (latency > Duration.zero) await Future<void>.delayed(latency);
  }
}

/// A container wired to fakes for every feature the builder touches.
ProviderContainer trailTestContainer({
  FakeTrailsApi? trails,
  FakeDiscoveryApi? discovery,
  FakeRoutingApi? routing,
  FakePlacesApi? places,
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
      locationServiceProvider.overrideWithValue(FakeLocationService()),
      routingApiProvider.overrideWithValue(routing ?? FakeRoutingApi()),
      discoveryApiProvider.overrideWithValue(discovery ?? FakeDiscoveryApi()),
      trailsApiProvider.overrideWithValue(trails ?? FakeTrailsApi()),
    ],
  );
}

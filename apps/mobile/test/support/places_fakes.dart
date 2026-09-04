import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:trilha_mobile/core/errors/app_failure.dart';
import 'package:trilha_mobile/features/map/application/location_service.dart';
import 'package:trilha_mobile/features/places/application/places_providers.dart';
import 'package:trilha_mobile/features/places/data/places_api.dart';
import 'package:trilha_mobile/app/bootstrap/providers.dart';
import 'package:trilha_mobile/app/config/app_config.dart';
import 'package:trilha_mobile/app/config/app_environment.dart';
import 'package:trilha_mobile/core/logging/app_logger.dart';
import 'package:trilha_mobile/core/observability/error_reporter.dart';
import 'package:trilha_mobile/features/auth/application/auth_providers.dart';
import 'package:trilha_mobile/features/places/domain/place.dart';

import 'auth_fakes.dart';

/// Real coordinates, so assertions about proximity mean something.
const LatLng kMarcoZero = LatLng(latitude: -8.0631, longitude: -34.8711);
const LatLng kIgrejaDaSe = LatLng(latitude: -8.0089, longitude: -34.8553);

const MapBounds kRecifeViewport = MapBounds(
  north: -8.00,
  south: -8.15,
  east: -34.80,
  west: -34.95,
);

PlaceMapItem mapItem(String id, {String name = 'Marco Zero', LatLng? at}) =>
    PlaceMapItem(
      id: id,
      name: name,
      categoryId: 'LANDMARK',
      position: at ?? kMarcoZero,
    );

PlaceListItem listItem(
  String id, {
  String name = 'Marco Zero',
  int? distanceMetres,
}) => PlaceListItem(
  id: id,
  name: name,
  categoryId: 'LANDMARK',
  position: kMarcoZero,
  description: 'A landmark.',
  distanceMetres: distanceMetres,
);

PlaceDetail placeDetail(String id, {String name = 'Marco Zero'}) => PlaceDetail(
  id: id,
  name: name,
  categoryId: 'LANDMARK',
  position: kMarcoZero,
  provenance: PlaceProvenance.community,
  description: 'A landmark in central Recife.',
  contributor: const PlaceContributor(
    username: 'ana',
    displayName: 'Ana Souza',
  ),
);

/// Scriptable stand-in for the Places HTTP boundary (§62, §63).
///
/// Records calls so tests can assert *how many* requests a gesture produced, which
/// is the whole point of the debounce and cancellation tests.
class FakePlacesApi implements PlacesEndpoints {
  List<PlaceMapItem> mapResults = <PlaceMapItem>[];
  List<PlaceListItem> searchResults = <PlaceListItem>[];
  List<PlaceListItem> nearbyResults = <PlaceListItem>[];
  PlaceDetail? detail;
  List<PlaceCategory> categoryResults = const <PlaceCategory>[
    PlaceCategory(id: 'LANDMARK', label: 'Landmark'),
    PlaceCategory(id: 'FOOD', label: 'Food & drink'),
  ];

  AppFailure? mapFailure;
  AppFailure? searchFailure;
  AppFailure? detailFailure;
  AppFailure? createFailure;

  /// Applied to every call, so a test can observe an in-flight state.
  Duration latency = Duration.zero;

  int mapCalls = 0;
  int searchCalls = 0;
  int nearbyCalls = 0;
  int detailCalls = 0;
  int createCalls = 0;

  final List<MapBounds> viewportsRequested = <MapBounds>[];
  final List<String> searchTerms = <String>[];
  final List<Map<String, Object?>> created = <Map<String, Object?>>[];

  /// Near-duplicates returned by the next create call.
  List<PlaceListItem> duplicatesOnCreate = const <PlaceListItem>[];

  Future<void> _pause(CancelToken? cancelToken) async {
    if (latency > Duration.zero) await Future<void>.delayed(latency);
    if (cancelToken?.isCancelled ?? false) {
      throw const AppFailure(
        kind: FailureKind.cancelled,
        message: 'Request cancelled.',
      );
    }
  }

  @override
  Future<List<PlaceMapItem>> mapItems(
    MapBounds bounds, {
    CancelToken? cancelToken,
  }) async {
    mapCalls += 1;
    viewportsRequested.add(bounds);
    await _pause(cancelToken);

    final AppFailure? failure = mapFailure;
    if (failure != null) throw failure;
    return mapResults;
  }

  @override
  Future<List<PlaceListItem>> search(
    String term, {
    LatLng? near,
    CancelToken? cancelToken,
  }) async {
    searchCalls += 1;
    searchTerms.add(term);
    await _pause(cancelToken);

    final AppFailure? failure = searchFailure;
    if (failure != null) throw failure;
    return searchResults;
  }

  @override
  Future<List<PlaceListItem>> nearby(
    LatLng centre, {
    int radiusMetres = 2000,
    CancelToken? cancelToken,
  }) async {
    nearbyCalls += 1;
    await _pause(cancelToken);
    return nearbyResults;
  }

  @override
  Future<PlaceDetail> byId(String id) async {
    detailCalls += 1;
    await _pause(null);

    final AppFailure? failure = detailFailure;
    if (failure != null) throw failure;
    return detail ?? placeDetail(id);
  }

  @override
  Future<List<PlaceCategory>> categories() async {
    await _pause(null);
    return categoryResults;
  }

  @override
  Future<CreatePlaceResult> create({
    required String name,
    required String categoryId,
    required LatLng position,
    String? description,
  }) async {
    createCalls += 1;
    created.add(<String, Object?>{
      'name': name,
      'categoryId': categoryId,
      'latitude': position.latitude,
      'longitude': position.longitude,
      'description': description,
    });
    await _pause(null);

    final AppFailure? failure = createFailure;
    if (failure != null) throw failure;

    return CreatePlaceResult(
      place: placeDetail('created-id', name: name),
      possibleDuplicates: duplicatesOnCreate,
    );
  }
}

/// Location service stand-in: a test binding has no location services.
class FakeLocationService implements LocationService {
  FakeLocationService({
    this.permission = LocationAvailability.notRequested,
    this.permissionAfterRequest,
    this.position,
  });

  LocationAvailability permission;

  /// What `request()` resolves to. Defaults to the current permission.
  LocationAvailability? permissionAfterRequest;

  ({double latitude, double longitude})? position;

  int requestCount = 0;
  int positionCount = 0;

  @override
  Future<LocationAvailability> currentPermission() async => permission;

  @override
  Future<LocationAvailability> request() async {
    requestCount += 1;
    permission = permissionAfterRequest ?? permission;
    return permission;
  }

  @override
  Future<({double latitude, double longitude})?> currentPosition() async {
    positionCount += 1;
    if (permission != LocationAvailability.granted) return null;
    return position;
  }
}

/// A container wired to fakes for both auth and places.
///
/// Built inline rather than by extending [authTestContainer]: `Override` is not
/// exported by `flutter_riverpod`, so the list cannot be passed across a function
/// boundary — but a literal infers fine.
ProviderContainer placesTestContainer({
  FakePlacesApi? places,
  FakeLocationService? location,
  FakeAuthApi? auth,
  FakeTokenStore? tokenStore,
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
      authApiProvider.overrideWithValue(auth ?? FakeAuthApi()),
      tokenStoreProvider.overrideWithValue(tokenStore ?? FakeTokenStore()),
      placesApiProvider.overrideWithValue(places ?? FakePlacesApi()),
      locationServiceProvider.overrideWithValue(
        location ?? FakeLocationService(),
      ),
    ],
  );
}

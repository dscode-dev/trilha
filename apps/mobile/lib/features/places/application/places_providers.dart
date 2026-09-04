import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/bootstrap/providers.dart';
import '../../../core/logging/app_logger.dart';
import '../../map/application/location_service.dart';
import '../../map/application/map_controller.dart';
import '../../map/application/map_state.dart';
import '../data/places_api.dart';
import '../domain/place.dart';

/// Composition for the places and map features.
///
/// The boundary (§54): `places` owns the Place domain — fetching, searching,
/// contributing. `map` owns the visual orchestration — viewport, camera, selection,
/// location. The map depends on places; places knows nothing about a map.

/// Overridden in tests with a fake implementation of [PlacesEndpoints].
final Provider<PlacesEndpoints> placesApiProvider = Provider<PlacesEndpoints>(
  (ref) => PlacesApi(ref.watch(apiClientProvider)),
  name: 'placesApi',
);

/// Overridden in tests; a test binding has no location services.
final Provider<LocationService> locationServiceProvider =
    Provider<LocationService>(
      (ref) => const GeolocatorLocationService(),
      name: 'locationService',
    );

final Provider<AppLogger> mapLoggerProvider = Provider<AppLogger>(
  (ref) => ref.watch(appLoggerProvider).child('map'),
  name: 'mapLogger',
);

final NotifierProvider<MapController, MapState> mapControllerProvider =
    NotifierProvider<MapController, MapState>(
      MapController.new,
      name: 'mapController',
    );

/// The categories vocabulary, fetched once and cached for the session.
final FutureProvider<List<PlaceCategory>> placeCategoriesProvider =
    FutureProvider<List<PlaceCategory>>(
      (ref) => ref.watch(placesApiProvider).categories(),
      name: 'placeCategories',
    );

/// Detail for one Place, keyed by id.
final placeDetailProvider = FutureProvider.family<PlaceDetail, String>(
  (ref, String id) => ref.watch(placesApiProvider).byId(id),
  name: 'placeDetail',
);

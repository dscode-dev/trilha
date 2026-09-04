import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/core/errors/app_failure.dart';
import 'package:trilha_mobile/features/map/application/location_service.dart';
import 'package:trilha_mobile/features/map/application/map_controller.dart';
import 'package:trilha_mobile/features/map/application/map_state.dart';
import 'package:trilha_mobile/features/places/application/places_providers.dart';
import 'package:trilha_mobile/features/places/domain/place.dart';

import '../../support/places_fakes.dart';

/// Viewport querying, debounce, cancellation and location handling (§44, §62).
void main() {
  late FakePlacesApi places;
  late FakeLocationService location;
  ProviderContainer? active;

  ProviderContainer container() =>
      active ??= placesTestContainer(places: places, location: location);

  MapController controller() =>
      container().read(mapControllerProvider.notifier);
  MapState state() => container().read(mapControllerProvider);

  /// Long enough for the controller's debounce plus any fake latency to elapse.
  Future<void> settle([Duration extra = Duration.zero]) async {
    await Future<void>.delayed(
      MapController.debounce + const Duration(milliseconds: 60) + extra,
    );
  }

  setUp(() {
    places = FakePlacesApi();
    location = FakeLocationService();
    active = null;
  });

  tearDown(() {
    active?.dispose();
    active = null;
  });

  group('viewport loading', () {
    test('starts empty and not loading', () {
      expect(state().places, isEmpty);
      expect(state().isLoadingPlaces, isFalse);
      expect(
        places.mapCalls,
        0,
        reason: 'nothing is fetched before a viewport exists',
      );
    });

    test('loads markers for a viewport', () async {
      places.mapResults = <PlaceMapItem>[
        mapItem('a'),
        mapItem('b', name: 'Igreja da Sé'),
      ];

      await controller().loadViewport(kRecifeViewport);

      expect(state().places.map((PlaceMapItem p) => p.id), <String>['a', 'b']);
      expect(state().isLoadingPlaces, isFalse);
      expect(places.mapCalls, 1);
    });

    test('passes the requested bounds through unchanged', () async {
      await controller().loadViewport(kRecifeViewport);

      expect(places.viewportsRequested.single, kRecifeViewport);
    });

    test('surfaces a failure without clearing the map', () async {
      places.mapResults = <PlaceMapItem>[mapItem('a')];
      await controller().loadViewport(kRecifeViewport);

      places.mapFailure = const AppFailure(
        kind: FailureKind.networkUnavailable,
        message: 'Offline',
      );
      await controller().loadViewport(kRecifeViewport);

      expect(state().failure, isNotNull);
      expect(state().isLoadingPlaces, isFalse);
      /* Markers already drawn stay: blanking the map on a transient error would be
         worse than showing slightly stale data. */
      expect(state().places, hasLength(1));
    });

    test('retry re-runs the last viewport', () async {
      places.mapFailure = const AppFailure(
        kind: FailureKind.networkUnavailable,
        message: 'Offline',
      );
      await controller().loadViewport(kRecifeViewport);
      expect(state().failure, isNotNull);

      places.mapFailure = null;
      places.mapResults = <PlaceMapItem>[mapItem('a')];
      await controller().retry();

      expect(state().failure, isNull);
      expect(state().places, hasLength(1));
    });
  });

  group('debounce and coalescing (§44)', () {
    test('a burst of camera movements produces one request', () async {
      final MapController map = controller();

      /* A pan emits continuously; without the debounce this would be one request
         per frame. */
      for (int i = 0; i < 12; i += 1) {
        map.onViewportChanged(
          MapBounds(
            north: -8.00 - i * 0.05,
            south: -8.15 - i * 0.05,
            east: -34.80,
            west: -34.95,
          ),
        );
      }
      await settle();

      expect(places.mapCalls, 1);
    });

    test('the request uses the final viewport, not the first', () async {
      final MapController map = controller();

      map.onViewportChanged(kRecifeViewport);
      const MapBounds last = MapBounds(
        north: -9.00,
        south: -9.15,
        east: -35.80,
        west: -35.95,
      );
      map.onViewportChanged(last);
      await settle();

      expect(places.viewportsRequested.single, last);
    });

    test('ignores drift too small to change what is drawn', () async {
      final MapController map = controller();

      await map.loadViewport(kRecifeViewport);
      expect(places.mapCalls, 1);

      /* A few metres of jitter while a finger rests on the screen. */
      map.onViewportChanged(
        const MapBounds(
          north: -8.0001,
          south: -8.1501,
          east: -34.8001,
          west: -34.9501,
        ),
      );
      await settle();

      expect(
        places.mapCalls,
        1,
        reason: 'a negligible shift must not re-query',
      );
    });

    test('a real pan does re-query', () async {
      final MapController map = controller();

      await map.loadViewport(kRecifeViewport);
      map.onViewportChanged(
        const MapBounds(north: -8.30, south: -8.45, east: -34.80, west: -34.95),
      );
      await settle();

      expect(places.mapCalls, 2);
    });
  });

  group('stale responses (§44)', () {
    test('a superseded response never overwrites a newer one', () async {
      places.latency = const Duration(milliseconds: 120);
      places.mapResults = <PlaceMapItem>[mapItem('old')];

      final MapController map = controller();
      final Future<void> first = map.loadViewport(kRecifeViewport);

      /* The second query starts before the first returns. */
      places.mapResults = <PlaceMapItem>[mapItem('new')];
      final Future<void> second = map.loadViewport(
        const MapBounds(north: -9.0, south: -9.15, east: -35.8, west: -35.95),
      );

      await Future.wait(<Future<void>>[first, second]);

      expect(state().places.single.id, 'new');
    });

    test('a cancelled request is not surfaced as an error', () async {
      places.latency = const Duration(milliseconds: 120);

      final MapController map = controller();
      final Future<void> first = map.loadViewport(kRecifeViewport);
      final Future<void> second = map.loadViewport(
        const MapBounds(north: -9.0, south: -9.15, east: -35.8, west: -35.95),
      );
      await Future.wait(<Future<void>>[first, second]);

      /* The app cancelled its own request; there is nothing to tell the user. */
      expect(state().failure, isNull);
    });
  });

  group('selection', () {
    test('selects and clears a place', () {
      final MapController map = controller();

      map.select('place-1');
      expect(state().selectedPlaceId, 'place-1');

      map.clearSelection();
      expect(state().selectedPlaceId, isNull);
    });
  });

  group('location (§40, §41, §42)', () {
    test('opening the map reads permission without prompting', () async {
      location.permission = LocationAvailability.denied;

      await controller().refreshLocationPermission();

      expect(state().locationAvailability, LocationAvailability.denied);
      expect(
        location.requestCount,
        0,
        reason: 'no dialog unless the user asks',
      );
    });

    test(
      'granting permission yields a position and records it in memory',
      () async {
        location
          ..permissionAfterRequest = LocationAvailability.granted
          ..position = (
            latitude: kMarcoZero.latitude,
            longitude: kMarcoZero.longitude,
          );

        final LatLng? position = await controller().locateMe();

        expect(position, isNotNull);
        expect(state().userPosition, kMarcoZero);
        expect(state().hasLocationPermission, isTrue);
      },
    );

    test(
      'a denied permission returns null and leaves the map usable',
      () async {
        location.permissionAfterRequest = LocationAvailability.denied;

        expect(await controller().locateMe(), isNull);
        expect(state().locationAvailability, LocationAvailability.denied);
        /* Crucially, nothing about the places state changed: the map still works. */
        expect(state().failure, isNull);
      },
    );

    test(
      'a permanently denied permission is distinguished from a plain denial',
      () async {
        location.permissionAfterRequest = LocationAvailability.deniedForever;

        expect(await controller().locateMe(), isNull);
        expect(
          state().locationAvailability,
          LocationAvailability.deniedForever,
        );
      },
    );

    test('disabled location services are reported as such', () async {
      location.permissionAfterRequest = LocationAvailability.serviceDisabled;

      expect(await controller().locateMe(), isNull);
      expect(
        state().locationAvailability,
        LocationAvailability.serviceDisabled,
      );
    });

    test(
      'granted permission with no fix does not fabricate a position',
      () async {
        location
          ..permissionAfterRequest = LocationAvailability.granted
          ..position = null;

        expect(await controller().locateMe(), isNull);
        expect(state().userPosition, isNull);
      },
    );

    test('the position is never handed to the places API', () async {
      location
        ..permissionAfterRequest = LocationAvailability.granted
        ..position = (
          latitude: kMarcoZero.latitude,
          longitude: kMarcoZero.longitude,
        );

      await controller().locateMe();
      await controller().loadViewport(kRecifeViewport);

      /* Viewport queries carry bounds, never the user's own coordinates (§42). */
      expect(places.viewportsRequested.single, kRecifeViewport);
      expect(places.nearbyCalls, 0);
    });
  });
}

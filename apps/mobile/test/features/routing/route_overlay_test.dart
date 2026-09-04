import 'package:flutter_test/flutter_test.dart';
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart' as mapbox;
import 'package:trilha_mobile/features/routing/presentation/route_overlay.dart';

import '../../support/places_fakes.dart';
import '../../support/routing_fakes.dart';

/// Route rendering, asserted through the annotation managers (§36, §38, §41).
///
/// A platform view cannot exist in a test binding, so the SDK's managers are stubbed
/// and the overlay is checked on what it *asks the map to do* — the geometry it sends,
/// the order of the coordinates, and what it deletes.
void main() {
  late _StubPolylineManager polylines;
  late _StubPointManager markers;
  late MapboxRouteOverlay overlay;

  setUp(() {
    polylines = _StubPolylineManager();
    markers = _StubPointManager();
    overlay = MapboxRouteOverlay(
      polylines: polylines,
      markers: markers,
      lineColor: 0xFF1B7F4B,
    );
  });

  test('draws the geometry as a single line', () async {
    await overlay.drawRoute(sampleRoute());

    expect(polylines.created, hasLength(1));
    final mapbox.LineString line = polylines.created.single.geometry;
    expect(line.coordinates, hasLength(3));
  });

  test('sends coordinates as longitude, latitude', () async {
    await overlay.drawRoute(sampleRoute());

    final mapbox.LineString line = polylines.created.single.geometry;
    final mapbox.Position first = line.coordinates.first;

    /* Reversing these draws the route off the coast of Somalia without any error,
       so it is asserted rather than assumed. */
    expect(first.lng, kMarcoZero.longitude);
    expect(first.lat, kMarcoZero.latitude);
  });

  test('marks the endpoints with letters rather than colour (§38)', () async {
    await overlay.drawRoute(sampleRoute());

    expect(
      markers.created.map((mapbox.PointAnnotationOptions o) => o.textField),
      <String>['A', 'B'],
    );
  });

  test('redrawing replaces the previous route instead of stacking', () async {
    await overlay.drawRoute(sampleRoute());
    await overlay.drawRoute(sampleRoute(distanceMeters: 5000));

    expect(polylines.created, hasLength(2));
    expect(polylines.deleted, hasLength(1));
    expect(markers.deleted, hasLength(2));
  });

  test('clearing removes only what the route added (§41)', () async {
    /* A Place marker put on the map by another feature, on the same manager the
       overlay would use if the screen had not given it its own. */
    final mapbox.PointAnnotation foreign = await markers.create(
      mapbox.PointAnnotationOptions(
        geometry: mapbox.Point(coordinates: mapbox.Position(0, 0)),
      ),
    );

    await overlay.drawRoute(sampleRoute());
    await overlay.clearRoute();

    expect(polylines.deleted, hasLength(1));
    expect(markers.deleted, hasLength(2));
    expect(
      markers.deleted.map((mapbox.PointAnnotation a) => a.id),
      isNot(contains(foreign.id)),
    );
  });

  test('clearing twice is harmless', () async {
    await overlay.drawRoute(sampleRoute());
    await overlay.clearRoute();
    await overlay.clearRoute();

    expect(polylines.deleted, hasLength(1));
    expect(markers.deleted, hasLength(2));
  });

  test('clearing before anything is drawn does nothing', () async {
    await overlay.clearRoute();

    expect(polylines.deleted, isEmpty);
    expect(markers.deleted, isEmpty);
  });
}

/// Records what the overlay asks of the SDK.
///
/// `noSuchMethod` covers the rest of the manager surface: the overlay uses two of its
/// methods, and stubbing the others by hand would be noise that rots on every SDK
/// upgrade.
class _StubPolylineManager implements mapbox.PolylineAnnotationManager {
  final List<mapbox.PolylineAnnotationOptions> created =
      <mapbox.PolylineAnnotationOptions>[];
  final List<mapbox.PolylineAnnotation> deleted = <mapbox.PolylineAnnotation>[];
  int _nextId = 0;

  @override
  Future<mapbox.PolylineAnnotation> create(
    mapbox.PolylineAnnotationOptions annotation,
  ) async {
    created.add(annotation);
    return mapbox.PolylineAnnotation(
      id: 'line-${_nextId++}',
      geometry: annotation.geometry,
    );
  }

  @override
  Future<void> delete(mapbox.PolylineAnnotation annotation) async {
    deleted.add(annotation);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _StubPointManager implements mapbox.PointAnnotationManager {
  final List<mapbox.PointAnnotationOptions> created =
      <mapbox.PointAnnotationOptions>[];
  final List<mapbox.PointAnnotation> deleted = <mapbox.PointAnnotation>[];
  int _nextId = 0;

  @override
  Future<mapbox.PointAnnotation> create(
    mapbox.PointAnnotationOptions annotation,
  ) async {
    created.add(annotation);
    return mapbox.PointAnnotation(
      id: 'point-${_nextId++}',
      geometry: annotation.geometry,
    );
  }

  @override
  Future<void> delete(mapbox.PointAnnotation annotation) async {
    deleted.add(annotation);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

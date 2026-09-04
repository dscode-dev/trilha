import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart' as mapbox;

import '../../places/domain/place.dart';
import '../domain/route.dart';

/// The commands a map surface must support to show a route (§67).
///
/// A seam, not a wrapper: three operations, so route drawing can be asserted in tests
/// without a platform view. Styling and rendering stay with the SDK.
abstract interface class RouteOverlay {
  Future<void> drawRoute(TrilhaRoute route);
  Future<void> clearRoute();
}

/// Draws the route as a Mapbox polyline with A and B endpoint markers.
class MapboxRouteOverlay implements RouteOverlay {
  MapboxRouteOverlay({
    required this.polylines,
    required this.markers,
    required this.lineColor,
  });

  final mapbox.PolylineAnnotationManager polylines;
  final mapbox.PointAnnotationManager markers;

  /// The brand green, passed in rather than imported: this file stays free of theme
  /// lookups so it can be driven from anywhere.
  final int lineColor;

  /// Endpoint annotations, tracked so they can be removed without touching the
  /// Place markers sharing the map (§41).
  final List<mapbox.PointAnnotation> _endpointMarkers =
      <mapbox.PointAnnotation>[];
  mapbox.PolylineAnnotation? _line;

  @override
  Future<void> drawRoute(TrilhaRoute route) async {
    await clearRoute();

    _line = await polylines.create(
      mapbox.PolylineAnnotationOptions(
        geometry: mapbox.LineString(
          coordinates: route.geometry
              .map((LatLng p) => mapbox.Position(p.longitude, p.latitude))
              .toList(),
        ),
        lineColor: lineColor,
        lineWidth: 5,
        lineOpacity: 0.85,
      ),
    );

    for (final ({RouteEndpoint endpoint, String label}) marker
        in <({RouteEndpoint endpoint, String label})>[
          (endpoint: route.origin, label: 'A'),
          (endpoint: route.destination, label: 'B'),
        ]) {
      _endpointMarkers.add(
        await markers.create(
          mapbox.PointAnnotationOptions(
            geometry: mapbox.Point(
              coordinates: mapbox.Position(
                marker.endpoint.position.longitude,
                marker.endpoint.position.latitude,
              ),
            ),
            /* Letters, so route endpoints are never mistaken for Places (§38). */
            textField: marker.label,
            textSize: 16,
            textHaloWidth: 2,
            iconSize: 1.4,
          ),
        ),
      );
    }
  }

  @override
  Future<void> clearRoute() async {
    final mapbox.PolylineAnnotation? line = _line;
    if (line != null) {
      await polylines.delete(line);
      _line = null;
    }

    for (final mapbox.PointAnnotation marker in _endpointMarkers) {
      await markers.delete(marker);
    }
    _endpointMarkers.clear();
  }
}

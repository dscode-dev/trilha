import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart' as mapbox;

import '../../places/domain/place.dart';

/// The slice of Mapbox the app actually drives (§63).
///
/// A seam, not a wrapper: it exposes camera intent and viewport reporting so those
/// can be exercised in tests without a platform view, and nothing more. Rendering,
/// gestures and styling stay with the SDK, where they belong.
abstract interface class MapCamera {
  /// Moves the camera. [animate] is false for the initial placement, where a
  /// fly-in from nowhere would be noise.
  Future<void> moveTo(LatLng position, {double? zoom, bool animate = true});

  /// The viewport currently shown, or null before the map is ready.
  Future<MapBounds?> visibleBounds();
}

/// Drives a real `MapboxMap`.
class MapboxCameraAdapter implements MapCamera {
  const MapboxCameraAdapter(this._map);

  final mapbox.MapboxMap _map;

  @override
  Future<void> moveTo(
    LatLng position, {
    double? zoom,
    bool animate = true,
  }) async {
    final mapbox.CameraOptions options = mapbox.CameraOptions(
      center: mapbox.Point(
        coordinates: mapbox.Position(position.longitude, position.latitude),
      ),
      zoom: zoom,
    );

    if (animate) {
      await _map.flyTo(options, mapbox.MapAnimationOptions(duration: 600));
    } else {
      await _map.setCamera(options);
    }
  }

  @override
  Future<MapBounds?> visibleBounds() async {
    final mapbox.CameraState camera = await _map.getCameraState();
    final mapbox.CoordinateBounds bounds = await _map.coordinateBoundsForCamera(
      mapbox.CameraOptions(
        center: camera.center,
        zoom: camera.zoom,
        bearing: camera.bearing,
        pitch: camera.pitch,
      ),
    );

    final mapbox.Position northEast = bounds.northeast.coordinates;
    final mapbox.Position southWest = bounds.southwest.coordinates;

    return MapBounds(
      north: northEast.lat.toDouble(),
      east: northEast.lng.toDouble(),
      south: southWest.lat.toDouble(),
      west: southWest.lng.toDouble(),
    );
  }
}

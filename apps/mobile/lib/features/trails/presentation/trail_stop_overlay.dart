import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart' as mapbox;

import '../../places/domain/place.dart';
import '../domain/trail.dart';

/// The commands a map surface must support to show a trail's stops (§60, §62).
///
/// A seam, like `RouteOverlay` and `CandidateOverlay`, so stop rendering can be
/// asserted without a platform view.
abstract interface class TrailStopOverlay {
  Future<void> showStops(List<TrailStop> stops);
  Future<void> clearStops();
}

/// Draws stops as numbered markers, distinct from Places and discovery candidates.
///
/// **Its own annotation manager**, for the same reason every other overlay has one:
/// clearing a trail must not remove a Place the user contributed or a candidate the
/// ranking suggested. Three managers, three independent lifetimes (§60).
class MapboxTrailStopOverlay implements TrailStopOverlay {
  MapboxTrailStopOverlay({required this.markers, required this.markerColor});

  final mapbox.PointAnnotationManager markers;

  /// Passed in rather than imported, so this file stays free of theme lookups.
  final int markerColor;

  final List<mapbox.PointAnnotation> _drawn = <mapbox.PointAnnotation>[];

  @override
  Future<void> showStops(List<TrailStop> stops) async {
    await clearStops();

    for (final TrailStop stop in stops) {
      final LatLng position = stop.location;

      _drawn.add(
        await markers.create(
          mapbox.PointAnnotationOptions(
            geometry: mapbox.Point(
              coordinates: mapbox.Position(
                position.longitude,
                position.latitude,
              ),
            ),
            /* The visiting order, not a category icon: while the builder is open,
               "which one is third" is the question being asked (§62). */
            textField: '${stop.position}',
            textSize: 16,
            textColor: markerColor,
            textHaloWidth: 2,
            iconSize: 1.2,
          ),
        ),
      );
    }
  }

  @override
  Future<void> clearStops() async {
    for (final mapbox.PointAnnotation annotation in _drawn) {
      await markers.delete(annotation);
    }
    _drawn.clear();
  }
}

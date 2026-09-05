import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart' as mapbox;

import '../../places/domain/place.dart';
import '../domain/route_candidate.dart';

/// The commands a map surface must support to show candidates (§56).
///
/// A seam, not a wrapper, for the same reason `RouteOverlay` is one: candidate drawing
/// can then be asserted without a platform view.
abstract interface class CandidateOverlay {
  Future<void> showCandidates(List<RouteCandidate> candidates);
  Future<void> highlight(String? placeId);
  Future<void> clearCandidates();
}

/// Draws candidates as their own annotations, distinct from Places and endpoints.
///
/// **Its own annotation manager.** Candidates, Places and route endpoints each get one,
/// so clearing candidates cannot remove a Place the user contributed, and clearing a
/// route cannot remove a candidate (§41, §56). Sharing a manager would make every
/// "clear" a guess about which annotations belonged to whom.
class MapboxCandidateOverlay implements CandidateOverlay {
  MapboxCandidateOverlay({required this.markers, required this.markerColor});

  final mapbox.PointAnnotationManager markers;

  /// Passed in rather than imported, so this file stays free of theme lookups.
  final int markerColor;

  /// Annotation id by place id, so a highlight can find its marker again.
  final Map<String, mapbox.PointAnnotation> _byPlaceId =
      <String, mapbox.PointAnnotation>{};

  static const double _restingSize = 1.0;
  static const double _selectedSize = 1.6;

  @override
  Future<void> showCandidates(List<RouteCandidate> candidates) async {
    await clearCandidates();

    for (final RouteCandidate candidate in candidates) {
      final mapbox.PointAnnotation annotation = await markers.create(
        _optionsFor(candidate, selected: false),
      );
      _byPlaceId[candidate.place.id] = annotation;
    }
  }

  /// Grows the selected marker and returns the others to their resting size (§57).
  @override
  Future<void> highlight(String? placeId) async {
    for (final MapEntry<String, mapbox.PointAnnotation> entry
        in _byPlaceId.entries) {
      final mapbox.PointAnnotation annotation = entry.value;
      final bool selected = entry.key == placeId;

      annotation.iconSize = selected ? _selectedSize : _restingSize;
      /* Size as well as colour: a highlight that exists only as a hue is invisible to
         a colour-blind user, and on a map it competes with the basemap besides. */
      annotation.textField = selected ? '●' : '·';
      await markers.update(annotation);
    }
  }

  @override
  Future<void> clearCandidates() async {
    for (final mapbox.PointAnnotation annotation in _byPlaceId.values) {
      await markers.delete(annotation);
    }
    _byPlaceId.clear();
  }

  mapbox.PointAnnotationOptions _optionsFor(
    RouteCandidate candidate, {
    required bool selected,
  }) {
    final LatLng position = candidate.place.position;

    return mapbox.PointAnnotationOptions(
      geometry: mapbox.Point(
        coordinates: mapbox.Position(position.longitude, position.latitude),
      ),
      textField: selected ? '●' : '·',
      textSize: 20,
      textColor: markerColor,
      textHaloWidth: 2,
      iconSize: selected ? _selectedSize : _restingSize,
    );
  }
}

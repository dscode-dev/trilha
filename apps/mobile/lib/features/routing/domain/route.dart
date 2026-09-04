import 'package:equatable/equatable.dart';

import '../../places/domain/place.dart';

/// A calculated path between two points.
///
/// A `Route` is not a `Trail`: it is what the road network says about getting from
/// A to B, with no name, no author and no stops. A Trail is a curated experience
/// built *over* routes and places, and it belongs to a later PR (constitution
/// §Routing).
class TrilhaRoute extends Equatable {
  const TrilhaRoute({
    required this.origin,
    required this.destination,
    required this.geometry,
    required this.distanceMeters,
    required this.durationSeconds,
    required this.bounds,
    required this.legs,
  });

  final RouteEndpoint origin;
  final RouteEndpoint destination;

  /// The line to draw, in WGS84 degrees.
  final List<LatLng> geometry;

  /// Canonical units come from the backend; formatting happens in the widgets (§15).
  final int distanceMeters;
  final int durationSeconds;

  final MapBounds bounds;
  final List<RouteLeg> legs;

  @override
  List<Object?> get props => <Object?>[
    origin,
    destination,
    geometry,
    distanceMeters,
    durationSeconds,
    bounds,
    legs,
  ];
}

/// One end of a route.
///
/// [placeId] is present when the point came from a Place, and absent when it came
/// from the device's location or a tap on the map. Routing never requires one (§7).
class RouteEndpoint extends Equatable {
  const RouteEndpoint({required this.position, this.placeId, this.label});

  final LatLng position;
  final String? placeId;

  /// What to show the user — a Place name, "Your location", or coordinates.
  final String? label;

  RouteEndpoint copyWith({LatLng? position, String? placeId, String? label}) =>
      RouteEndpoint(
        position: position ?? this.position,
        placeId: placeId ?? this.placeId,
        label: label ?? this.label,
      );

  @override
  List<Object?> get props => <Object?>[position, placeId, label];
}

class RouteLeg extends Equatable {
  const RouteLeg({
    required this.distanceMeters,
    required this.durationSeconds,
    this.summary,
  });

  final int distanceMeters;
  final int durationSeconds;
  final String? summary;

  @override
  List<Object?> get props => <Object?>[
    distanceMeters,
    durationSeconds,
    summary,
  ];
}

/// Formats a duration for display (§15, §39).
///
/// The backend deals only in seconds; deciding that 6,480 reads as "1h48" is a
/// presentation choice and lives here.
String formatDuration(int seconds) {
  if (seconds < 60) return '${seconds}s';

  final int totalMinutes = (seconds / 60).round();
  final int hours = totalMinutes ~/ 60;
  final int minutes = totalMinutes % 60;

  if (hours == 0) return '${minutes}min';
  if (minutes == 0) return '${hours}h';
  return '${hours}h${minutes.toString().padLeft(2, '0')}';
}

/// Formats a route distance for display (§15).
///
/// Distinct from the Places formatter: a route is typically long enough that metres
/// are noise, so this switches to kilometres sooner and drops the decimal earlier.
String formatRouteDistance(int metres) {
  if (metres < 1000) return '$metres m';

  final double km = metres / 1000;
  return km < 100 ? '${km.toStringAsFixed(1)} km' : '${km.round()} km';
}

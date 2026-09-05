import 'package:equatable/equatable.dart';

import '../../places/domain/place.dart';

/// A trail: what the user composed, not what the road network computed (§1).
///
/// Routing answers *how to get there*; a Trail records *what was chosen* — which
/// places, in which order, deliberately saved. The two are kept apart here for the
/// same reason they are on the server: a Trail outlives any particular calculation of
/// its route, and a route belongs to nobody.
class Trail extends Equatable {
  const Trail({
    required this.id,
    required this.status,
    required this.origin,
    required this.destination,
    required this.stops,
    required this.revision,
    required this.route,
    required this.baseRoute,
    required this.detour,
    required this.routeIsCurrent,
    required this.maxStops,
    required this.updatedAt,
  });

  final String id;
  final TrailStatus status;
  final TrailEndpoint origin;
  final TrailEndpoint destination;
  final List<TrailStop> stops;

  /// Send back as `expectedRevision` on the next mutation (§25, §57).
  final int revision;

  /// What routing last said. Null when the provider was unreachable at creation.
  final TrailRoute? route;
  final TrailMetrics? baseRoute;

  /// What the stops add over the same endpoints with none. Null when unmeasured.
  final TrailMetrics? detour;

  /// Whether [route] describes the composition as it now stands.
  final bool routeIsCurrent;

  /// The server's ceiling, so the UI never has to guess it (§14).
  final int maxStops;

  final DateTime updatedAt;

  bool get isFull => stops.length >= maxStops;

  bool containsPlace(String placeId) =>
      stops.any((TrailStop s) => s.placeId == placeId);

  /// A local reordering, for the drag preview (§56).
  ///
  /// Returns a Trail that looks like the drop already happened, without touching the
  /// server. The revision is unchanged on purpose: this is not a new version, it is a
  /// picture of one being proposed.
  ///
  /// Indices are post-removal, matching `ReorderableListView.onReorderItem` — the
  /// caller does not compensate for the dragged row leaving the list.
  Trail withStopsReordered(int oldIndex, int newIndex) {
    final List<TrailStop> next = <TrailStop>[...stops];
    final TrailStop moved = next.removeAt(oldIndex);
    next.insert(newIndex, moved);

    return Trail(
      id: id,
      status: status,
      origin: origin,
      destination: destination,
      stops: <TrailStop>[
        for (final (int index, TrailStop stop) in next.indexed)
          stop.atPosition(index + 1),
      ],
      revision: revision,
      route: route,
      baseRoute: baseRoute,
      detour: detour,
      routeIsCurrent: routeIsCurrent,
      maxStops: maxStops,
      updatedAt: updatedAt,
    );
  }

  @override
  List<Object?> get props => <Object?>[
    id,
    status,
    origin,
    destination,
    stops,
    revision,
    route,
    baseRoute,
    detour,
    routeIsCurrent,
    maxStops,
    updatedAt,
  ];
}

/// Lifecycle (§7).
///
/// `finalized` means "I finished composing this", never "I published it" — nobody
/// else can see a Trail. Editing a finalized Trail returns it to draft (§46).
enum TrailStatus {
  draft,
  finalized,
  archived;

  static TrailStatus fromCode(String code) => switch (code) {
    'FINALIZED' => TrailStatus.finalized,
    'ARCHIVED' => TrailStatus.archived,
    _ => TrailStatus.draft,
  };
}

class TrailEndpoint extends Equatable {
  const TrailEndpoint({required this.position, this.placeId, this.label});

  final LatLng position;
  final String? placeId;
  final String? label;

  @override
  List<Object?> get props => <Object?>[position, placeId, label];
}

/// A stop, always a resolved Place (§10).
class TrailStop extends Equatable {
  const TrailStop({
    required this.id,
    required this.placeId,
    required this.position,
    required this.source,
    required this.placeName,
    required this.placeCategoryId,
    required this.location,
  });

  final String id;
  final String placeId;

  /// 1-based visiting order.
  final int position;
  final TrailStopSource source;
  final String placeName;
  final String placeCategoryId;
  final LatLng location;

  TrailStop atPosition(int newPosition) => TrailStop(
    id: id,
    placeId: placeId,
    position: newPosition,
    source: source,
    placeName: placeName,
    placeCategoryId: placeCategoryId,
    location: location,
  );

  @override
  List<Object?> get props => <Object?>[
    id,
    placeId,
    position,
    source,
    placeName,
    placeCategoryId,
    location,
  ];
}

/// Where a stop came from. Provenance, never a quality signal (§11).
enum TrailStopSource {
  discovery,
  search,
  manual;

  String get code => switch (this) {
    TrailStopSource.discovery => 'DISCOVERY',
    TrailStopSource.search => 'SEARCH',
    TrailStopSource.manual => 'MANUAL',
  };

  static TrailStopSource fromCode(String code) => switch (code) {
    'DISCOVERY' => TrailStopSource.discovery,
    'SEARCH' => TrailStopSource.search,
    _ => TrailStopSource.manual,
  };
}

/// The stored route: the line and what it measured (§18).
class TrailRoute extends Equatable {
  const TrailRoute({
    required this.geometry,
    required this.bounds,
    required this.distanceMeters,
    required this.durationSeconds,
  });

  final List<LatLng> geometry;
  final MapBounds bounds;
  final int distanceMeters;
  final int durationSeconds;

  @override
  List<Object?> get props => <Object?>[
    geometry,
    bounds,
    distanceMeters,
    durationSeconds,
  ];
}

class TrailMetrics extends Equatable {
  const TrailMetrics({
    required this.distanceMeters,
    required this.durationSeconds,
  });

  final int distanceMeters;
  final int durationSeconds;

  @override
  List<Object?> get props => <Object?>[distanceMeters, durationSeconds];
}

/// A row in "Minhas trilhas" (§42, §68). No geometry, by design.
class TrailSummary extends Equatable {
  const TrailSummary({
    required this.id,
    required this.status,
    required this.stopCount,
    required this.revision,
    required this.updatedAt,
    this.originLabel,
    this.destinationLabel,
    this.distanceMeters,
    this.durationSeconds,
  });

  final String id;
  final TrailStatus status;
  final String? originLabel;
  final String? destinationLabel;
  final int stopCount;
  final int? distanceMeters;
  final int? durationSeconds;
  final int revision;
  final DateTime updatedAt;

  @override
  List<Object?> get props => <Object?>[
    id,
    status,
    originLabel,
    destinationLabel,
    stopCount,
    distanceMeters,
    durationSeconds,
    revision,
    updatedAt,
  ];
}

/// How a trail reads in a list: "Recife → João Pessoa".
String trailTitle(TrailSummary trail) {
  final String from = trail.originLabel ?? 'Origem';
  final String to = trail.destinationLabel ?? 'Destino';
  return '$from → $to';
}

/// "3 paradas · 145 km · 2h11", omitting whatever is not known yet.
String trailSubtitle(TrailSummary trail) {
  final List<String> parts = <String>[
    trail.stopCount == 1 ? '1 parada' : '${trail.stopCount} paradas',
  ];

  final int? distance = trail.distanceMeters;
  if (distance != null) parts.add(formatRouteDistance(distance));

  final int? duration = trail.durationSeconds;
  if (duration != null) parts.add(formatDuration(duration));

  return parts.join(' · ');
}

/// Formats a duration the way a driver would say it.
String formatDuration(int seconds) {
  if (seconds < 60) return '${seconds}s';

  final int totalMinutes = (seconds / 60).round();
  final int hours = totalMinutes ~/ 60;
  final int minutes = totalMinutes % 60;

  if (hours == 0) return '${minutes}min';
  if (minutes == 0) return '${hours}h';
  return '${hours}h${minutes.toString().padLeft(2, '0')}';
}

/// Formats a route distance, dropping precision as it grows.
String formatRouteDistance(int metres) {
  if (metres < 1000) return '$metres m';

  final double km = metres / 1000;
  return km < 100 ? '${km.toStringAsFixed(1)} km' : '${km.round()} km';
}

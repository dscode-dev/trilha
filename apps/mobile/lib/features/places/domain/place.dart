import 'package:equatable/equatable.dart';

/// A geographic point in WGS84 degrees.
///
/// The API speaks degrees; Web Mercator is Mapbox's internal business and never
/// reaches the domain (§20).
class LatLng extends Equatable {
  const LatLng({required this.latitude, required this.longitude});

  final double latitude;
  final double longitude;

  @override
  List<Object?> get props => <Object?>[latitude, longitude];

  @override
  String toString() => 'LatLng($latitude, $longitude)';
}

/// A rectangular viewport, as the map query needs it.
class MapBounds extends Equatable {
  const MapBounds({
    required this.north,
    required this.south,
    required this.east,
    required this.west,
  });

  final double north;
  final double south;
  final double east;
  final double west;

  /// Latitude span, used to decide whether a pan moved far enough to re-query.
  double get latitudeSpan => north - south;
  double get longitudeSpan => east - west;

  /// Whether [other] is materially different from this viewport.
  ///
  /// Small drifts happen constantly while a finger is on the screen; re-querying for
  /// each would produce hundreds of requests for one gesture (§44).
  bool differsFrom(MapBounds other, {double threshold = 0.2}) {
    final double latShift =
        (north - other.north).abs() + (south - other.south).abs();
    final double lngShift =
        (east - other.east).abs() + (west - other.west).abs();
    final double scale = latitudeSpan.abs() + longitudeSpan.abs();
    if (scale == 0) return true;
    return (latShift + lngShift) / scale > threshold;
  }

  @override
  List<Object?> get props => <Object?>[north, south, east, west];
}

/// The marker-sized view of a Place (§27).
class PlaceMapItem extends Equatable {
  const PlaceMapItem({
    required this.id,
    required this.name,
    required this.categoryId,
    required this.position,
  });

  final String id;
  final String name;
  final String categoryId;
  final LatLng position;

  @override
  List<Object?> get props => <Object?>[id, name, categoryId, position];
}

/// A Place in a search or proximity list.
class PlaceListItem extends Equatable {
  const PlaceListItem({
    required this.id,
    required this.name,
    required this.categoryId,
    required this.position,
    this.description,
    this.distanceMetres,
  });

  final String id;
  final String name;
  final String categoryId;
  final LatLng position;
  final String? description;

  /// Metres from the query point, when the query had one.
  final int? distanceMetres;

  @override
  List<Object?> get props => <Object?>[
    id,
    name,
    categoryId,
    position,
    description,
    distanceMetres,
  ];
}

/// Where a Place record came from (§11).
enum PlaceProvenance {
  community,
  system,
  unknown;

  static PlaceProvenance parse(String? value) => switch (value) {
    'COMMUNITY' => PlaceProvenance.community,
    'SYSTEM' => PlaceProvenance.system,
    _ => PlaceProvenance.unknown,
  };

  /// Shown on the detail sheet so a reader knows how much to trust the entry.
  String get label => switch (this) {
    PlaceProvenance.community => 'Added by the community',
    PlaceProvenance.system => 'Added by Trilha',
    PlaceProvenance.unknown => 'Origin unknown',
  };
}

/// Public attribution for a community contribution.
class PlaceContributor extends Equatable {
  const PlaceContributor({required this.username, required this.displayName});

  final String username;
  final String displayName;

  @override
  List<Object?> get props => <Object?>[username, displayName];
}

/// The full Place behind a detail surface.
///
/// Carries no rating, no safety score and no opening hours: none of those exist in
/// the product yet, and rendering a placeholder for them would tell the user
/// something untrue (§48).
class PlaceDetail extends Equatable {
  const PlaceDetail({
    required this.id,
    required this.name,
    required this.categoryId,
    required this.position,
    required this.provenance,
    this.description,
    this.contributor,
  });

  final String id;
  final String name;
  final String categoryId;
  final LatLng position;
  final PlaceProvenance provenance;
  final String? description;
  final PlaceContributor? contributor;

  @override
  List<Object?> get props => <Object?>[
    id,
    name,
    categoryId,
    position,
    provenance,
    description,
    contributor,
  ];
}

/// A category from the server's fixed vocabulary.
class PlaceCategory extends Equatable {
  const PlaceCategory({required this.id, required this.label});

  final String id;
  final String label;

  @override
  List<Object?> get props => <Object?>[id, label];
}

/// Formats a distance for display (§21).
///
/// The backend deals only in metres; choosing when to say "1.2 km" is a presentation
/// decision and lives here, not in the transport or the domain of the API.
String formatDistance(int metres) {
  if (metres < 1000) return '$metres m';
  final double km = metres / 1000;
  return '${km.toStringAsFixed(km < 10 ? 1 : 0)} km';
}

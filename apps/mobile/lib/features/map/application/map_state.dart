import 'package:equatable/equatable.dart';

import '../../../core/errors/app_failure.dart';
import '../../places/domain/place.dart';
import 'location_service.dart';

/// Everything the map surface renders from (§45).
///
/// One object rather than a scatter of booleans, so an impossible combination —
/// loading and failed at once — cannot be represented.
class MapState extends Equatable {
  const MapState({
    this.places = const <PlaceMapItem>[],
    this.isLoadingPlaces = false,
    this.failure,
    this.selectedPlaceId,
    this.locationAvailability = LocationAvailability.notRequested,
    this.userPosition,
    this.truncated = false,
  });

  final List<PlaceMapItem> places;

  /// Markers are refreshed without blocking the map: panning stays responsive while
  /// a query is in flight (§57).
  final bool isLoadingPlaces;

  final AppFailure? failure;
  final String? selectedPlaceId;
  final LocationAvailability locationAvailability;

  /// Device-local only; never persisted or transmitted (§42).
  final LatLng? userPosition;

  /// The viewport held more places than the server returns at once.
  final bool truncated;

  bool get hasLocationPermission =>
      locationAvailability == LocationAvailability.granted;
  bool get isEmpty => places.isEmpty && !isLoadingPlaces && failure == null;

  MapState copyWith({
    List<PlaceMapItem>? places,
    bool? isLoadingPlaces,
    AppFailure? failure,
    bool clearFailure = false,
    String? selectedPlaceId,
    bool clearSelection = false,
    LocationAvailability? locationAvailability,
    LatLng? userPosition,
    bool? truncated,
  }) {
    return MapState(
      places: places ?? this.places,
      isLoadingPlaces: isLoadingPlaces ?? this.isLoadingPlaces,
      failure: clearFailure ? null : (failure ?? this.failure),
      selectedPlaceId: clearSelection
          ? null
          : (selectedPlaceId ?? this.selectedPlaceId),
      locationAvailability: locationAvailability ?? this.locationAvailability,
      userPosition: userPosition ?? this.userPosition,
      truncated: truncated ?? this.truncated,
    );
  }

  @override
  List<Object?> get props => <Object?>[
    places,
    isLoadingPlaces,
    failure,
    selectedPlaceId,
    locationAvailability,
    userPosition,
    truncated,
  ];
}

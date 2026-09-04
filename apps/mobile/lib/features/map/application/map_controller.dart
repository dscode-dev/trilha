import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/logging/app_logger.dart';
import '../../../core/errors/app_failure.dart';
import '../../places/data/places_api.dart';
import '../../places/domain/place.dart';
import '../../places/application/places_providers.dart';
import 'location_service.dart';
import 'map_state.dart';

/// Drives the map surface (§44, §45).
///
/// Widgets report camera movement here and read state back; nothing in the
/// presentation layer talks to the API.
class MapController extends Notifier<MapState> {
  PlacesEndpoints get _places => ref.read(placesApiProvider);
  LocationService get _location => ref.read(locationServiceProvider);
  AppLogger get _logger => ref.read(mapLoggerProvider);

  /// How long the camera must be still before a viewport is queried.
  ///
  /// A pan emits camera changes continuously; without this every frame would become
  /// a request. Long enough to coalesce a gesture, short enough to feel immediate.
  static const Duration debounce = Duration(milliseconds: 400);

  Timer? _debounceTimer;
  CancelToken? _inFlight;
  MapBounds? _lastQueried;

  /// Monotonic id of the newest request, so a slow earlier response cannot overwrite
  /// a newer one that already landed.
  int _requestSequence = 0;

  @override
  MapState build() {
    ref.onDispose(() {
      _debounceTimer?.cancel();
      _inFlight?.cancel('map controller disposed');
    });
    return const MapState();
  }

  /// Called whenever the camera settles on a new viewport.
  void onViewportChanged(MapBounds bounds) {
    /* Ignore drift that would return substantially the same markers. */
    final MapBounds? previous = _lastQueried;
    if (previous != null && !bounds.differsFrom(previous)) return;

    _debounceTimer?.cancel();
    _debounceTimer = Timer(debounce, () => unawaited(loadViewport(bounds)));
  }

  /// Fetches markers for [bounds], superseding any request already running.
  Future<void> loadViewport(MapBounds bounds) async {
    _inFlight?.cancel('superseded by a newer viewport');
    final CancelToken cancelToken = CancelToken();
    _inFlight = cancelToken;

    final int sequence = ++_requestSequence;
    _lastQueried = bounds;
    state = state.copyWith(isLoadingPlaces: true, clearFailure: true);

    try {
      final List<PlaceMapItem> items = await _places.mapItems(
        bounds,
        cancelToken: cancelToken,
      );
      /* A response from a superseded request is discarded rather than rendered:
         otherwise a slow early query could repaint markers for a viewport the user
         has already panned away from. */
      if (!ref.mounted || sequence != _requestSequence) return;

      state = state.copyWith(places: items, isLoadingPlaces: false);
    } on AppFailure catch (failure) {
      if (!ref.mounted || sequence != _requestSequence) return;
      if (failure.kind == FailureKind.cancelled) return;

      _logger.warning(
        'Map viewport query failed',
        context: {'kind': failure.kind.name},
      );
      state = state.copyWith(isLoadingPlaces: false, failure: failure);
    }
  }

  /// Re-runs the last viewport query. Bound to the error state's retry action.
  Future<void> retry() async {
    final MapBounds? bounds = _lastQueried;
    if (bounds != null) await loadViewport(bounds);
  }

  void select(String placeId) {
    state = state.copyWith(selectedPlaceId: placeId);
  }

  void clearSelection() {
    state = state.copyWith(clearSelection: true);
  }

  /// Reads the stored permission without prompting, so opening the map never
  /// triggers a system dialog the user did not ask for (§40).
  Future<void> refreshLocationPermission() async {
    final LocationAvailability availability = await _location
        .currentPermission();
    if (!ref.mounted) return;
    state = state.copyWith(locationAvailability: availability);
  }

  /// Asks for permission and, if granted, resolves a position.
  ///
  /// Returns the position so the caller can move the camera; the map remains fully
  /// usable when this returns null.
  Future<LatLng?> locateMe() async {
    final LocationAvailability availability = await _location.request();
    if (!ref.mounted) return null;

    state = state.copyWith(locationAvailability: availability);
    if (availability != LocationAvailability.granted) return null;

    final ({double latitude, double longitude})? fix = await _location
        .currentPosition();
    if (!ref.mounted || fix == null) return null;

    final LatLng position = LatLng(
      latitude: fix.latitude,
      longitude: fix.longitude,
    );
    /* Held in memory for this session only — never written anywhere (§42). */
    state = state.copyWith(userPosition: position);
    return position;
  }
}

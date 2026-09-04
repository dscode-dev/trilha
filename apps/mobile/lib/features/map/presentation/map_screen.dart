import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart' as mapbox;

import '../../../app/config/map_config.dart';
import '../../../app/theme/app_radius.dart';
import '../../../app/theme/app_spacing.dart';
import '../../places/application/places_providers.dart';
import '../../places/domain/place.dart';
import '../../places/presentation/contribute_place_screen.dart';
import '../../places/presentation/place_detail_sheet.dart';
import '../../places/presentation/place_search_bar.dart';
import '../application/location_service.dart';
import '../application/map_state.dart';
import 'map_camera.dart';
import 'map_unavailable.dart';

/// The primary product surface (§38, §39).
///
/// Map-first: the map fills the screen, search floats above it, and everything else
/// arrives as a bottom sheet. No app bar, no dashboard, no cards competing with the
/// thing the user came to look at.
class MapScreen extends ConsumerStatefulWidget {
  const MapScreen({super.key});

  @override
  ConsumerState<MapScreen> createState() => _MapScreenState();
}

class _MapScreenState extends ConsumerState<MapScreen> {
  mapbox.PointAnnotationManager? _markers;
  MapCamera? _camera;

  /// Maps an annotation back to the Place it represents, so a tap can resolve one.
  final Map<String, String> _annotationToPlaceId = <String, String>{};

  /// Markers currently drawn, to avoid rebuilding an unchanged set on every rebuild.
  List<PlaceMapItem> _rendered = const <PlaceMapItem>[];

  @override
  void initState() {
    super.initState();
    // Reads the stored decision without prompting: opening a map must not trigger a
    // permission dialog nobody asked for (§40).
    unawaited(
      Future<void>.microtask(
        () => ref
            .read(mapControllerProvider.notifier)
            .refreshLocationPermission(),
      ),
    );
  }

  Future<void> _onMapCreated(mapbox.MapboxMap map) async {
    _camera = MapboxCameraAdapter(map);
    _markers = await map.annotations.createPointAnnotationManager();

    /* `tapEvents` supersedes the listener-object API, which 2.30 deprecates. */
    _markers?.tapEvents(onTap: _onMarkerTapped);

    /* Mapbox's own logo and attribution stay visible — required by their terms —
       but the scale bar and compass would crowd a phone screen. */
    await map.scaleBar.updateSettings(mapbox.ScaleBarSettings(enabled: false));
    await map.compass.updateSettings(mapbox.CompassSettings(enabled: false));

    await _queryVisibleViewport();
  }

  /// Camera-idle is the right trigger: querying mid-gesture would fire continuously
  /// and fight the user's finger (§44).
  Future<void> _onCameraIdle(mapbox.MapIdleEventData _) async {
    final MapBounds? bounds = await _camera?.visibleBounds();
    if (bounds != null && mounted) {
      ref.read(mapControllerProvider.notifier).onViewportChanged(bounds);
    }
  }

  Future<void> _queryVisibleViewport() async {
    final MapBounds? bounds = await _camera?.visibleBounds();
    if (bounds != null && mounted) {
      await ref.read(mapControllerProvider.notifier).loadViewport(bounds);
    }
  }

  void _onMarkerTapped(mapbox.PointAnnotation annotation) {
    final String? placeId = _annotationToPlaceId[annotation.id];
    if (placeId == null) return;

    ref.read(mapControllerProvider.notifier).select(placeId);
    unawaited(_showPlaceSheet(placeId));
  }

  Future<void> _showPlaceSheet(String placeId) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => PlaceDetailSheet(placeId: placeId),
    );
    if (mounted) ref.read(mapControllerProvider.notifier).clearSelection();
  }

  /// Redraws markers when the set actually changed.
  Future<void> _syncMarkers(List<PlaceMapItem> places) async {
    final mapbox.PointAnnotationManager? markers = _markers;
    if (markers == null) return;
    if (_sameIds(places, _rendered)) return;

    _rendered = places;
    _annotationToPlaceId.clear();
    await markers.deleteAll();

    for (final PlaceMapItem place in places) {
      final mapbox.PointAnnotation annotation = await markers.create(
        mapbox.PointAnnotationOptions(
          geometry: mapbox.Point(
            coordinates: mapbox.Position(
              place.position.longitude,
              place.position.latitude,
            ),
          ),
          textField: place.name,
          textSize: 11,
          textOffset: <double>[0, 1.6],
          textHaloWidth: 1.2,
          iconSize: 1.1,
        ),
      );
      _annotationToPlaceId[annotation.id] = place.id;
    }
  }

  static bool _sameIds(List<PlaceMapItem> a, List<PlaceMapItem> b) {
    if (a.length != b.length) return false;
    for (int i = 0; i < a.length; i += 1) {
      if (a[i].id != b[i].id) return false;
    }
    return true;
  }

  Future<void> _locateMe() async {
    final LatLng? position = await ref
        .read(mapControllerProvider.notifier)
        .locateMe();
    if (position == null) {
      if (mounted) _explainLocationState();
      return;
    }
    await _camera?.moveTo(position, zoom: MapConfig.focusedZoom);
  }

  /// Says what happened rather than failing silently, and never blocks the map (§40).
  void _explainLocationState() {
    final LocationAvailability availability = ref
        .read(mapControllerProvider)
        .locationAvailability;
    final String message = switch (availability) {
      LocationAvailability.denied => 'Location is off for Trilha. You can still explore the map by dragging it.',
      LocationAvailability.deniedForever => 'Location is blocked in Settings. You can still explore the map by dragging it.',
      LocationAvailability.serviceDisabled =>
        'Location services are switched off on this device.',
      _ => 'Could not get your location right now.',
    };

    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _focusOn(PlaceListItem place) async {
    await _camera?.moveTo(place.position, zoom: MapConfig.focusedZoom);
    if (!mounted) return;
    ref.read(mapControllerProvider.notifier).select(place.id);
    await _showPlaceSheet(place.id);
  }

  @override
  Widget build(BuildContext context) {
    // Without a token the SDK renders nothing; saying so beats a blank screen (§86).
    if (!MapConfig.hasAccessToken) return const MapUnavailable();

    final MapState state = ref.watch(mapControllerProvider);
    ref.listen<MapState>(mapControllerProvider, (
      MapState? previous,
      MapState next,
    ) {
      if (previous?.places != next.places) unawaited(_syncMarkers(next.places));
    });

    return Scaffold(
      body: Stack(
        children: <Widget>[
          Positioned.fill(
            child: mapbox.MapWidget(
              key: const ValueKey<String>('trilha-map'),
              /* `viewport` supersedes `cameraOptions`, deprecated in 2.30. */
              viewport: mapbox.CameraViewportState(
                center: mapbox.Point(
                  coordinates: mapbox.Position(
                    MapConfig.defaultLongitude,
                    MapConfig.defaultLatitude,
                  ),
                ),
                zoom: MapConfig.defaultZoom,
              ),
              onMapCreated: (mapbox.MapboxMap map) =>
                  unawaited(_onMapCreated(map)),
              onMapIdleListener: (mapbox.MapIdleEventData data) =>
                  unawaited(_onCameraIdle(data)),
            ),
          ),

          /* Search floats over the map rather than pushing it down (§39). */
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: PlaceSearchBar(
                onSelected: (PlaceListItem p) => unawaited(_focusOn(p)),
              ),
            ),
          ),

          if (state.isLoadingPlaces)
            const Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: SafeArea(child: _DiscreteLoadingBar()),
            ),

          if (state.failure != null)
            Positioned(
              left: AppSpacing.md,
              right: AppSpacing.md,
              bottom: AppSpacing.xxl + AppSpacing.lg,
              child: _MapErrorBanner(
                onRetry: () =>
                    unawaited(ref.read(mapControllerProvider.notifier).retry()),
              ),
            ),

          Positioned(
            right: AppSpacing.md,
            bottom: AppSpacing.xxl,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                FloatingActionButton.small(
                  heroTag: 'locate-me',
                  tooltip: 'Show my location',
                  onPressed: () => unawaited(_locateMe()),
                  child: Icon(
                    state.hasLocationPermission
                        ? Icons.my_location
                        : Icons.location_searching,
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
                FloatingActionButton(
                  heroTag: 'add-place',
                  tooltip: 'Add a place',
                  onPressed: () => unawaited(_startContribution()),
                  child: const Icon(Icons.add_location_alt_outlined),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _startContribution() async {
    final MapBounds? bounds = await _camera?.visibleBounds();
    if (!mounted) return;

    /* The centre of what the user is looking at is the most likely intent, and the
       next screen lets them confirm it on the map (§51). */
    final LatLng target = bounds == null
        ? const LatLng(
            latitude: MapConfig.defaultLatitude,
            longitude: MapConfig.defaultLongitude,
          )
        : LatLng(
            latitude: (bounds.north + bounds.south) / 2,
            longitude: (bounds.east + bounds.west) / 2,
          );

    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => ContributePlaceScreen(initialPosition: target),
      ),
    );

    if (mounted) await _queryVisibleViewport();
  }
}

/// A thin progress line, so refreshing markers never blocks the map (§57).
class _DiscreteLoadingBar extends StatelessWidget {
  const _DiscreteLoadingBar();

  @override
  Widget build(BuildContext context) {
    return const SizedBox(
      height: 3,
      child: LinearProgressIndicator(minHeight: 3),
    );
  }
}

class _MapErrorBanner extends StatelessWidget {
  const _MapErrorBanner({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final ColorScheme colors = Theme.of(context).colorScheme;

    return Material(
      elevation: 2,
      borderRadius: AppRadius.allMd,
      color: colors.errorContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.sm,
        ),
        child: Row(
          children: <Widget>[
            Icon(Icons.cloud_off, size: 20, color: colors.onErrorContainer),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Text(
                'Could not load places here.',
                style: TextStyle(color: colors.onErrorContainer),
              ),
            ),
            TextButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart' as mapbox;

import '../../../app/config/map_config.dart';
import '../../../app/theme/app_radius.dart';
import '../../../app/theme/app_spacing.dart';
import '../../../app/theme/app_colors.dart';
import '../../places/application/places_providers.dart';
import '../../places/domain/place.dart';
import '../../places/presentation/contribute_place_screen.dart';
import '../../places/presentation/place_detail_sheet.dart';
import '../../places/presentation/place_search_bar.dart';
import '../application/location_service.dart';
import '../application/map_state.dart';
import '../../discovery/application/discovery_providers.dart';
import '../../discovery/application/discovery_state.dart';
import '../../discovery/domain/route_candidate.dart';
import '../../discovery/presentation/candidate_overlay.dart';
import '../../discovery/presentation/discovery_sheet.dart';
import '../../trails/application/trail_providers.dart';
import '../../trails/application/trail_state.dart';
import '../../trails/domain/trail.dart';
import '../../trails/presentation/trail_builder_sheet.dart';
import '../../trails/presentation/trail_stop_overlay.dart';
import '../../trails/presentation/trail_routes.dart';
import '../../routing/application/routing_controller.dart';
import '../../routing/application/routing_providers.dart';
import '../../routing/application/routing_state.dart';
import '../../routing/domain/route.dart';
import '../../routing/presentation/route_overlay.dart';
import '../../routing/presentation/route_panel.dart';
import 'map_camera.dart';
import 'map_unavailable.dart';

/// The primary product surface (§38, §39).
///
/// Map-first: the map fills the screen, search floats above it, and everything else
/// arrives as a bottom sheet. No app bar, no dashboard, no cards competing with the
/// thing the user came to look at.
class MapScreen extends ConsumerStatefulWidget {
  const MapScreen({this.resumeTrailId, super.key});

  /// A saved trail to reopen, from `?trail=`.
  ///
  /// Resuming needs nothing but this id: the builder rebuilds itself from one detail
  /// read, with no memory of the session that created the trail (§69, §116).
  final String? resumeTrailId;

  @override
  ConsumerState<MapScreen> createState() => _MapScreenState();
}

class _MapScreenState extends ConsumerState<MapScreen> {
  mapbox.PointAnnotationManager? _markers;
  MapCamera? _camera;
  RouteOverlay? _routeOverlay;
  CandidateOverlay? _candidateOverlay;
  TrailStopOverlay? _trailStopOverlay;

  /// Which endpoint the next selection fills. Null when not building a route.
  _EndpointSlot? _awaitingSelection;

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

    final String? resumeTrailId = widget.resumeTrailId;
    if (resumeTrailId != null) {
      unawaited(
        Future<void>.microtask(
          () => ref.read(trailControllerProvider.notifier).open(resumeTrailId),
        ),
      );
    }
  }

  Future<void> _onMapCreated(mapbox.MapboxMap map) async {
    _camera = MapboxCameraAdapter(map);
    _markers = await map.annotations.createPointAnnotationManager();

    final mapbox.PolylineAnnotationManager polylines = await map.annotations
        .createPolylineAnnotationManager();
    final mapbox.PointAnnotationManager endpointMarkers = await map.annotations
        .createPointAnnotationManager();
    /* Candidates get their own manager, so clearing them never touches a Place the
       user contributed or an endpoint the route drew (§56). */
    _candidateOverlay = MapboxCandidateOverlay(
      markers: await map.annotations.createPointAnnotationManager(),
      markerColor: AppColors.brandGreen.toARGB32(),
    );

    /* A third manager, so a trail's stops, the discovery candidates and the Places
       each clear independently (§60). */
    _trailStopOverlay = MapboxTrailStopOverlay(
      markers: await map.annotations.createPointAnnotationManager(),
      markerColor: AppColors.brandGreen.toARGB32(),
    );

    _routeOverlay = MapboxRouteOverlay(
      polylines: polylines,
      /* A separate manager from the Place markers, so clearing a route cannot
         remove Places from the map (§41). */
      markers: endpointMarkers,
      lineColor: AppColors.brandGreen.toARGB32(),
    );

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

    /* While a route endpoint is being chosen, tapping a Place selects it as that
       endpoint rather than opening its details (§34). */
    final _EndpointSlot? slot = _awaitingSelection;
    if (slot != null) {
      final PlaceMapItem? place = ref
          .read(mapControllerProvider)
          .places
          .where((PlaceMapItem p) => p.id == placeId)
          .firstOrNull;

      if (place != null) {
        _assignEndpoint(
          slot,
          RouteEndpoint(
            position: place.position,
            placeId: place.id,
            label: place.name,
          ),
        );
        return;
      }
    }

    ref.read(mapControllerProvider.notifier).select(placeId);
    unawaited(_showPlaceSheet(placeId));
  }

  /// Fills the pending endpoint slot and leaves selection mode.
  void _assignEndpoint(_EndpointSlot slot, RouteEndpoint endpoint) {
    final RoutingController routing = ref.read(
      routingControllerProvider.notifier,
    );
    switch (slot) {
      case _EndpointSlot.origin:
        routing.setOrigin(endpoint);
      case _EndpointSlot.destination:
        routing.setDestination(endpoint);
    }
    setState(() => _awaitingSelection = null);
  }

  /// Offers the ways an endpoint can be chosen (§33, §34).
  Future<void> _pickEndpoint(_EndpointSlot slot) async {
    setState(() => _awaitingSelection = slot);

    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (BuildContext sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (slot == _EndpointSlot.origin)
              ListTile(
                leading: const Icon(Icons.my_location),
                title: const Text('Use my location'),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  unawaited(_useCurrentLocation());
                },
              ),
            ListTile(
              leading: const Icon(Icons.center_focus_strong),
              title: const Text('Use the centre of the map'),
              subtitle: const Text('Drag the map first, then pick this'),
              onTap: () {
                Navigator.of(sheetContext).pop();
                unawaited(_useMapCentre(slot));
              },
            ),
            ListTile(
              leading: const Icon(Icons.search),
              title: const Text('Search for a place'),
              onTap: () {
                Navigator.of(sheetContext).pop();
                unawaited(_searchForEndpoint(slot));
              },
            ),
            ListTile(
              leading: const Icon(Icons.place_outlined),
              title: const Text('Tap a place on the map'),
              subtitle: const Text('Close this and tap any marker'),
              onTap: () => Navigator.of(sheetContext).pop(),
            ),
          ],
        ),
      ),
    );
  }

  /// Reuses the Places search rather than growing a second one (§34).
  Future<void> _searchForEndpoint(_EndpointSlot slot) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (BuildContext sheetContext) => Padding(
        /* Lifted above the keyboard, which covers the results otherwise. */
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(sheetContext).viewInsets.bottom,
        ),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: PlaceSearchBar(
              onSelected: (PlaceListItem place) {
                Navigator.of(sheetContext).pop();
                _assignEndpoint(
                  slot,
                  RouteEndpoint(
                    position: place.position,
                    placeId: place.id,
                    label: place.name,
                  ),
                );
              },
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _useCurrentLocation() async {
    final bool located = await ref
        .read(routingControllerProvider.notifier)
        .useCurrentLocationAsOrigin();

    if (!mounted) return;
    setState(() => _awaitingSelection = null);

    if (!located) {
      /* Location is unavailable, but route building is not blocked: the user can
         still pick a point on the map (§33). */
      _explainLocationState();
      return;
    }

    final LatLng? position = ref.read(mapControllerProvider).userPosition;
    if (position != null) {
      await _camera?.moveTo(position, zoom: MapConfig.focusedZoom);
    }
  }

  Future<void> _useMapCentre(_EndpointSlot slot) async {
    final MapBounds? bounds = await _camera?.visibleBounds();
    if (!mounted || bounds == null) return;

    _assignEndpoint(
      slot,
      RouteEndpoint(
        position: LatLng(
          latitude: (bounds.north + bounds.south) / 2,
          longitude: (bounds.east + bounds.west) / 2,
        ),
      ),
    );
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
    final RoutingState routing = ref.watch(routingControllerProvider);
    final DiscoveryState discovery = ref.watch(discoveryControllerProvider);
    final TrailState trailState = ref.watch(trailControllerProvider);
    /* Route mode starts at the moment the user asks for it, before an endpoint
       exists, so the panel is there to receive the first selection. */
    final bool routeMode = routing.isActive || _awaitingSelection != null;

    ref.listen<MapState>(mapControllerProvider, (
      MapState? previous,
      MapState next,
    ) {
      if (previous?.places != next.places) unawaited(_syncMarkers(next.places));
    });

    /* Drawing follows state rather than being commanded from a button handler, so a
       route cleared by any path also disappears from the map (§41, §44). */
    ref.listen<RoutingState>(routingControllerProvider, (
      RoutingState? previous,
      RoutingState next,
    ) {
      if (previous?.routeOrNull == next.routeOrNull) return;
      unawaited(_syncRoute(next.routeOrNull));
    });

    /* A trail's stops and its line follow its state, so closing the builder or
       reordering a stop is reflected on the map without a widget commanding it. */
    ref.listen<TrailState>(trailControllerProvider, (
      TrailState? previous,
      TrailState next,
    ) {
      if (previous?.trail?.stops != next.trail?.stops) {
        unawaited(
          _trailStopOverlay?.showStops(next.trail?.stops ?? <TrailStop>[]),
        );
      }
      if (previous?.trail?.route != next.trail?.route) {
        unawaited(_syncTrailRoute(next.trail));
      }
    });

    /* The same discipline for candidates: markers follow the discovery state, so a
       cleared route cannot leave suggestions on screen for a journey nobody is
       taking (§57, §62). */
    ref.listen<DiscoveryState>(discoveryControllerProvider, (
      DiscoveryState? previous,
      DiscoveryState next,
    ) {
      if (previous?.candidates != next.candidates) {
        unawaited(_candidateOverlay?.showCandidates(next.candidates));
      }
      if (previous?.selectedPlaceId != next.selectedPlaceId) {
        unawaited(_candidateOverlay?.highlight(next.selectedPlaceId));
      }
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

          /* Search floats over the map rather than pushing it down (§39). While a
             route is being built the panel replaces it, so the two never compete. */
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: routeMode
                  ? RoutePanel(
                      onPickOrigin: () =>
                          unawaited(_pickEndpoint(_EndpointSlot.origin)),
                      onPickDestination: () =>
                          unawaited(_pickEndpoint(_EndpointSlot.destination)),
                    )
                  : PlaceSearchBar(
                      onSelected: (PlaceListItem p) => unawaited(_focusOn(p)),
                    ),
            ),
          ),

          /* Anchored to the bottom rather than pushed into a modal: the detour only
             means something next to the route it is measured against (§55). */
          if (trailState.hasTrail || discovery.isActive)
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.of(context).size.height * 0.5,
                ),
                /* One sheet at a time. While a trail is open the builder is what the
                   user is working in; discovery becomes a way to add to it, reached
                   from "Adicionar parada" (§63). */
                child: trailState.hasTrail
                    ? TrailBuilderSheet(
                        onAddStop: () => unawaited(_addStopToTrail()),
                        onClose: () =>
                            ref.read(trailControllerProvider.notifier).close(),
                        onStopTap: (TrailStop stop) =>
                            unawaited(_camera?.moveTo(stop.location)),
                      )
                    : DiscoverySheet(onCandidateTap: _focusOnCandidate),
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
                /* Discovery is offered only once a route exists, and only on a tap:
                   each run costs a route calculation and a travel-cost matrix
                   upstream, so it must never fire on an incidental rebuild (§62,
                   §65). */
                if (routing.routeOrNull != null &&
                    !discovery.isActive &&
                    !trailState.hasTrail) ...<Widget>[
                  FloatingActionButton.extended(
                    heroTag: 'discover-along-route',
                    icon: const Icon(Icons.explore_outlined),
                    label: const Text('Descobertas'),
                    onPressed: () => unawaited(
                      ref.read(discoveryControllerProvider.notifier).discover(),
                    ),
                  ),
                  const SizedBox(height: AppSpacing.sm),
                ],

                if (!trailState.hasTrail) ...<Widget>[
                  FloatingActionButton.small(
                    heroTag: 'my-trails',
                    tooltip: 'Minhas trilhas',
                    onPressed: () => context.push(TrailRoutes.listPath),
                    child: const Icon(Icons.bookmark_border),
                  ),
                  const SizedBox(height: AppSpacing.sm),
                ],

                /* A trail is created once the user asks for one, never when the screen
                   opens — otherwise browsing the map would leave a trail of empty
                   drafts behind (§67). */
                if (routing.routeOrNull != null &&
                    !trailState.hasTrail) ...<Widget>[
                  FloatingActionButton.extended(
                    heroTag: 'start-trail',
                    icon: const Icon(Icons.route_outlined),
                    label: const Text('Montar trilha'),
                    onPressed: () => unawaited(
                      ref
                          .read(trailControllerProvider.notifier)
                          .createFromRoute(),
                    ),
                  ),
                  const SizedBox(height: AppSpacing.sm),
                ],

                const SizedBox(height: AppSpacing.sm),
                FloatingActionButton.small(
                  heroTag: 'plan-route',
                  tooltip: routeMode ? 'Close route planning' : 'Plan a route',
                  onPressed: () {
                    if (routeMode) {
                      /* Resetting the route clears discovery too, because the
                         controller watches routing — the candidates described a
                         journey that no longer exists (§62). */
                      ref.read(routingControllerProvider.notifier).reset();
                      setState(() => _awaitingSelection = null);
                    } else {
                      unawaited(_pickEndpoint(_EndpointSlot.origin));
                    }
                  },
                  child: Icon(routeMode ? Icons.close : Icons.directions),
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

  /// Draws the trail's own line, replacing whatever the route overlay was showing.
  Future<void> _syncTrailRoute(Trail? trail) async {
    final RouteOverlay? overlay = _routeOverlay;
    final TrailRoute? route = trail?.route;
    if (overlay == null) return;

    if (trail == null || route == null) {
      await overlay.clearRoute();
      return;
    }

    /* The trail's stored geometry, not a fresh calculation: this is what the user
       saved, and re-routing on open would quietly change it (§69). */
    await overlay.drawRoute(
      TrilhaRoute(
        origin: RouteEndpoint(
          position: trail.origin.position,
          placeId: trail.origin.placeId,
          label: trail.origin.label,
        ),
        destination: RouteEndpoint(
          position: trail.destination.position,
          placeId: trail.destination.placeId,
          label: trail.destination.label,
        ),
        geometry: route.geometry,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        bounds: route.bounds,
        legs: const <RouteLeg>[],
      ),
    );
  }

  /// Offers the ways a stop can be added (§63, §65).
  Future<void> _addStopToTrail() async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (BuildContext sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            ListTile(
              leading: const Icon(Icons.explore_outlined),
              title: const Text('Descobertas pelo caminho'),
              subtitle: const Text('Lugares que somam pouco tempo à viagem'),
              onTap: () {
                Navigator.of(sheetContext).pop();
                unawaited(_addFromDiscovery());
              },
            ),
            ListTile(
              leading: const Icon(Icons.search),
              title: const Text('Buscar um lugar'),
              onTap: () {
                Navigator.of(sheetContext).pop();
                unawaited(_addFromSearch());
              },
            ),
          ],
        ),
      ),
    );
  }

  /// Discovery as a source of stops (§34, §63, §64).
  Future<void> _addFromDiscovery() async {
    final DiscoveryState discovery = ref.read(discoveryControllerProvider);
    if (discovery is DiscoveryIdle) {
      unawaited(ref.read(discoveryControllerProvider.notifier).discover());
    }

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (BuildContext sheetContext) => ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(sheetContext).size.height * 0.7,
        ),
        child: DiscoverySheet(
          onCandidateTap: (RouteCandidate candidate) {
            Navigator.of(sheetContext).pop();
            /* Discovery never writes a trail itself; the intent travels through the
               trail controller, which owns the mutation (§34). */
            unawaited(
              ref
                  .read(trailControllerProvider.notifier)
                  .addStop(candidate.place.id, TrailStopSource.discovery),
            );
          },
        ),
      ),
    );
  }

  /// The Places search as a source of stops (§35, §65).
  Future<void> _addFromSearch() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (BuildContext sheetContext) => Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(sheetContext).viewInsets.bottom,
        ),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            /* The same search the map uses. A second one would drift from it the first
               time either changed (§65). */
            child: PlaceSearchBar(
              onSelected: (PlaceListItem place) {
                Navigator.of(sheetContext).pop();
                unawaited(
                  ref
                      .read(trailControllerProvider.notifier)
                      .addStop(place.id, TrailStopSource.search),
                );
              },
            ),
          ),
        ),
      ),
    );
  }

  /// Centres a tapped candidate without losing the route from view (§57).
  Future<void> _focusOnCandidate(RouteCandidate candidate) async {
    /* A gentle move rather than a zoom-to-fit: the user is comparing this place
       against the line, and snapping the camera to it would hide the comparison. */
    await _camera?.moveTo(candidate.place.position);
  }

  /// Draws or clears the route, and frames it when one appears (§37).
  Future<void> _syncRoute(TrilhaRoute? route) async {
    final RouteOverlay? overlay = _routeOverlay;
    if (overlay == null) return;

    if (route == null) {
      await overlay.clearRoute();
      return;
    }

    await overlay.drawRoute(route);
    /* Bounds come from the geometry, so the whole route fits whatever its length —
       a fixed zoom would blank a long drive and over-zoom a short one. */
    await _camera?.fitBounds(route.bounds);
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

/// Which route endpoint a pending selection will fill.
enum _EndpointSlot { origin, destination }

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

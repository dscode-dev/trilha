import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/logging/app_logger.dart';
import '../../routing/application/routing_providers.dart';
import '../../routing/application/routing_state.dart';
import '../../routing/domain/route.dart';
import '../data/discovery_api.dart';
import '../domain/route_candidate.dart';
import 'discovery_providers.dart';
import 'discovery_state.dart';

/// Drives discovery along the current route (§62, §63, §64, §65).
///
/// Runs only when the user has a route and asks for it, or changes a filter — never
/// on an incidental UI change (§65). Each request costs the backend a route
/// calculation and a travel-cost matrix, so a controller that fired on every rebuild
/// would be spending real money on redraws.
class DiscoveryController extends Notifier<DiscoveryState> {
  DiscoveryEndpoints get _api => ref.read(discoveryApiProvider);
  AppLogger get _logger => ref.read(discoveryLoggerProvider);

  CancelToken? _inFlight;

  /// Identifies the newest request, so a slow earlier one cannot overwrite it (§64).
  int _requestSequence = 0;

  @override
  DiscoveryState build() {
    ref.onDispose(() => _inFlight?.cancel('discovery controller disposed'));

    /* Discovery is meaningless without a route, and stale the moment the route
       changes. Watching routing rather than being told by a widget means a cleared
       route cannot leave candidates on screen for a journey nobody is taking. */
    ref.listen<RoutingState>(routingControllerProvider, (
      RoutingState? previous,
      RoutingState next,
    ) {
      if (previous?.routeOrNull != next.routeOrNull) reset();
    });

    return const DiscoveryIdle();
  }

  /// Runs discovery for the current route, if there is one (§62).
  ///
  /// Returns silently when there is no successful route: discovery cannot invent the
  /// journey it is supposed to search along.
  Future<void> discover({List<String>? categories}) async {
    final RoutingState routing = ref.read(routingControllerProvider);
    final TrilhaRoute? route = routing.routeOrNull;
    if (route == null) return;

    final List<String> filters = categories ?? state.categories;

    _inFlight?.cancel('superseded by a newer discovery request');
    final CancelToken cancelToken = CancelToken();
    _inFlight = cancelToken;

    final int sequence = ++_requestSequence;
    state = DiscoveryLoading(categories: filters);

    try {
      final DiscoveryResult result = await _api.discover(
        origin: route.origin,
        destination: route.destination,
        categories: filters,
        cancelToken: cancelToken,
      );

      /* A response for a request the user has already replaced is discarded rather
         than shown (§64). */
      if (!ref.mounted || sequence != _requestSequence) return;

      state = result.candidates.isEmpty
          ? DiscoveryEmpty(categories: filters)
          : DiscoverySuccess(
              candidates: result.candidates,
              policyVersion: result.policyVersion,
              categories: filters,
            );

      /* Counts and the policy version are safe to record. The route, the categories
         and the places are not: together they describe where someone is going and
         what they were looking for (§53). */
      _logger.info(
        'Discovery completed',
        context: <String, Object?>{
          'candidates': result.candidates.length,
          'policyVersion': result.policyVersion,
        },
      );
    } on AppFailure catch (failure) {
      if (!ref.mounted || sequence != _requestSequence) return;
      if (failure.kind == FailureKind.cancelled) return;

      _logger.warning(
        'Discovery failed',
        context: <String, Object?>{'kind': failure.kind.name},
      );
      state = DiscoveryFailure(failure: failure, categories: filters);
    }
  }

  /// Applies a category filter and re-runs against the same route (§60).
  Future<void> setCategories(List<String> categories) async {
    /* Reusing the current route rather than recalculating it in the client: the
       backend derives the route from the endpoints either way, and the user has not
       changed where they are going. */
    await discover(categories: categories);
  }

  /// Toggles one category, which is how the chips behave.
  Future<void> toggleCategory(String categoryId) async {
    final List<String> next = <String>[...state.categories];
    if (!next.remove(categoryId)) next.add(categoryId);

    await setCategories(next);
  }

  /// Highlights a candidate on both the map and the list (§57).
  ///
  /// Selection is a view concern and costs nothing, so it never triggers a request.
  void select(String? placeId) {
    final DiscoveryState current = state;
    if (current is! DiscoverySuccess) return;
    if (current.selectedPlaceId == placeId) return;

    state = current.withSelection(placeId);
  }

  /// Clears everything discovery owns, and nothing else.
  void reset() {
    _cancelInFlight();
    state = const DiscoveryIdle();
  }

  void _cancelInFlight() {
    _inFlight?.cancel('discovery inputs changed');
    _inFlight = null;
    /* Bumped so any response still in flight is recognised as stale. */
    _requestSequence += 1;
  }
}

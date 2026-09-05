import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/logging/app_logger.dart';
import '../../routing/application/routing_providers.dart';
import '../../routing/application/routing_state.dart';
import '../../routing/domain/route.dart' as routing;
import '../data/trails_api.dart';
import '../domain/trail.dart';
import 'trail_providers.dart';
import 'trail_state.dart';

/// Drives the Trail Builder (§55, §56, §57, §66).
///
/// **The backend is the source of truth.** Every composition change is a request, and
/// the trail this controller holds is whatever the server last returned. There is no
/// local draft to reconcile, which is what makes "close the app and come back" work
/// without a sync protocol — and what makes an autosave button unnecessary.
///
/// The three rules that shape everything here:
///
/// - **One mutation per gesture** (§55). A drag produces one request on drop, not one
///   per frame; each change re-routes upstream, so a chatty client spends real money.
/// - **Optimistic only for the preview** (§56). A reorder shows immediately and is
///   rolled back if the server refuses. Nothing else is applied before confirmation.
/// - **Stale answers are discarded** (§57). Responses carry a revision; one that
///   describes a version older than what is on screen is dropped rather than applied.
class TrailController extends Notifier<TrailState> {
  TrailEndpoints get _api => ref.read(trailsApiProvider);
  AppLogger get _logger => ref.read(trailLoggerProvider);

  /// Identifies the newest request, so a slow earlier one cannot overwrite it.
  int _requestSequence = 0;

  @override
  TrailState build() => const TrailState();

  /// Starts a trail from the current routing selection (§67).
  ///
  /// Deliberately not called when the builder screen opens: a trail is created once
  /// the user has said where they are going and asked for it, so browsing the map
  /// never leaves a trail of empty drafts behind.
  Future<void> createFromRoute() async {
    final RoutingState routingState = ref.read(routingControllerProvider);
    final routing.RouteEndpoint? origin = routingState.origin;
    final routing.RouteEndpoint? destination = routingState.destination;
    if (origin == null || destination == null) return;

    await _run(
      () => _api.create(
        origin: TrailEndpoint(
          position: origin.position,
          placeId: origin.placeId,
          label: origin.label,
        ),
        destination: TrailEndpoint(
          position: destination.position,
          placeId: destination.placeId,
          label: destination.label,
        ),
      ),
      event: 'trail.created',
    );
  }

  /// Opens a saved trail (§69, §116).
  ///
  /// Everything the builder needs comes from this one read — the stored geometry
  /// included — so a resumed trail is not re-routed just because it was opened. The
  /// snapshot is what the user saved; re-asking the provider would quietly change it.
  Future<void> open(String trailId) async {
    final int sequence = ++_requestSequence;
    state = state.copyWith(
      isLoading: true,
      clearFailure: true,
      conflictDetected: false,
    );

    try {
      final Trail trail = await _api.byId(trailId);
      if (!ref.mounted || sequence != _requestSequence) return;

      state = TrailState(trail: trail);
    } on AppFailure catch (failure) {
      if (!ref.mounted || sequence != _requestSequence) return;
      state = state.copyWith(isLoading: false, failure: failure);
    }
  }

  Future<void> addStop(String placeId, TrailStopSource source) async {
    final Trail? trail = state.trail;
    if (trail == null || state.isMutating) return;

    await _run(
      () => _api.addStop(
        trailId: trail.id,
        placeId: placeId,
        source: source,
        expectedRevision: trail.revision,
      ),
      event: 'trail.stop.added',
    );
  }

  Future<void> removeStop(String stopId) async {
    final Trail? trail = state.trail;
    if (trail == null || state.isMutating) return;

    await _run(
      () => _api.removeStop(
        trailId: trail.id,
        stopId: stopId,
        expectedRevision: trail.revision,
      ),
      event: 'trail.stop.removed',
    );
  }

  /// Applies a completed drag (§55, §56).
  ///
  /// The new order is shown immediately so the list does not snap back under the
  /// finger, then confirmed by one request. If the server refuses — a conflict, a
  /// routing failure — the previous order is restored: a list that keeps a change the
  /// server rejected is lying about what is saved.
  Future<void> reorderStops(int oldIndex, int newIndex) async {
    final Trail? trail = state.trail;
    if (trail == null || state.isMutating) return;
    if (oldIndex == newIndex) return;

    final Trail optimistic = trail.withStopsReordered(oldIndex, newIndex);
    state = state.copyWith(
      trail: optimistic,
      isMutating: true,
      clearFailure: true,
    );

    final int sequence = ++_requestSequence;

    try {
      final Trail confirmed = await _api.reorderStops(
        trailId: trail.id,
        stopIds: optimistic.stops.map((TrailStop s) => s.id).toList(),
        expectedRevision: trail.revision,
      );

      if (!ref.mounted || sequence != _requestSequence) return;
      state = TrailState(trail: confirmed);
      _logger.info(
        'Trail reordered',
        context: <String, Object?>{'stops': confirmed.stops.length},
      );
    } on AppFailure catch (failure) {
      if (!ref.mounted || sequence != _requestSequence) return;

      /* Roll back to exactly what the server last confirmed. */
      state = state.copyWith(
        trail: trail,
        isMutating: false,
        failure: failure,
        conflictDetected: failure.kind == FailureKind.conflict,
      );
      _logger.warning(
        'Trail reorder rolled back',
        context: <String, Object?>{'kind': failure.kind.name},
      );
    }
  }

  /// Re-asks the provider for the current composition (§70).
  Future<void> recalculate() async {
    final Trail? trail = state.trail;
    if (trail == null || state.isMutating) return;

    await _run(
      () =>
          _api.recalculate(trailId: trail.id, expectedRevision: trail.revision),
      event: 'trail.recalculated',
    );
  }

  /// Marks the trail finished (§45, §71). Not publication.
  Future<void> finalize() async {
    final Trail? trail = state.trail;
    if (trail == null || state.isMutating) return;

    await _run(
      () => _api.finalize(trailId: trail.id, expectedRevision: trail.revision),
      event: 'trail.finalized',
    );
  }

  /// Closes the builder without deleting anything — the trail is already saved.
  void close() {
    _requestSequence += 1;
    state = state.cleared();
  }

  /// Reloads after a conflict, so the user sees what actually changed (§78).
  Future<void> reloadAfterConflict() async {
    final Trail? trail = state.trail;
    if (trail == null) return;

    await open(trail.id);
  }

  /// Runs a mutation, keeping the previous trail if it fails (§83).
  Future<void> _run(
    Future<Trail> Function() call, {
    required String event,
  }) async {
    final Trail? previous = state.trail;
    final int sequence = ++_requestSequence;
    state = state.copyWith(
      isMutating: true,
      clearFailure: true,
      conflictDetected: false,
    );

    try {
      final Trail trail = await call();
      if (!ref.mounted || sequence != _requestSequence) return;

      state = TrailState(trail: trail);
      /* Counts only. A trail's geometry and its stops are the user's own travel plans
         and never reach a log line (§76). */
      _logger.info(
        event,
        context: <String, Object?>{
          'stops': trail.stops.length,
          'revision': trail.revision,
        },
      );
    } on AppFailure catch (failure) {
      if (!ref.mounted || sequence != _requestSequence) return;

      /* The server rejected the change, so nothing was written there and nothing
         changes here either. */
      state = TrailState(
        trail: previous,
        failure: failure,
        conflictDetected: failure.kind == FailureKind.conflict,
      );
      _logger.warning(
        'Trail mutation failed',
        context: <String, Object?>{'event': event, 'kind': failure.kind.name},
      );
    }
  }
}

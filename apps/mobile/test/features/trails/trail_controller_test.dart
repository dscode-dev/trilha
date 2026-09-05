import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/core/errors/app_failure.dart';
import 'package:trilha_mobile/features/routing/application/routing_controller.dart';
import 'package:trilha_mobile/features/routing/application/routing_providers.dart';
import 'package:trilha_mobile/features/trails/application/trail_controller.dart';
import 'package:trilha_mobile/features/trails/application/trail_providers.dart';
import 'package:trilha_mobile/features/trails/application/trail_state.dart';
import 'package:trilha_mobile/features/trails/domain/trail.dart';

import '../../support/routing_fakes.dart';
import '../../support/trail_fakes.dart';

/// Trail creation, mutation, rollback, conflict and resume (§94).
void main() {
  late FakeTrailsApi api;
  late FakeRoutingApi routingApi;
  ProviderContainer? active;

  ProviderContainer container() =>
      active ??= trailTestContainer(trails: api, routing: routingApi);

  TrailController controller() =>
      container().read(trailControllerProvider.notifier);
  TrailState state() => container().read(trailControllerProvider);
  RoutingController routing() =>
      container().read(routingControllerProvider.notifier);

  Future<void> withRoute() async {
    routing()
      ..setOrigin(originEndpoint())
      ..setDestination(destinationEndpoint());
    await routing().calculate();
  }

  setUp(() {
    api = FakeTrailsApi();
    routingApi = FakeRoutingApi();
    active = null;
  });

  tearDown(() {
    active?.dispose();
    active = null;
  });

  group('creation (§67)', () {
    test('starts with no trail', () {
      expect(state().hasTrail, isFalse);
      expect(state().trail, isNull);
    });

    test('does nothing without a route', () async {
      await controller().createFromRoute();

      /* Creating a draft just because a screen opened would leave a trail of empty
         drafts behind every time someone browses the map. */
      expect(api.createCalls, 0);
      expect(state().hasTrail, isFalse);
    });

    test('creates from the current routing selection', () async {
      await withRoute();

      await controller().createFromRoute();

      expect(api.createCalls, 1);
      expect(state().trail?.id, 'trail-1');
      expect(state().trail?.revision, 1);
    });

    test('keeps no trail when creation fails', () async {
      api.failure = const AppFailure(
        kind: FailureKind.providerUnavailable,
        message: 'Upstream is down.',
      );
      await withRoute();

      await controller().createFromRoute();

      expect(state().hasTrail, isFalse);
      expect(state().failure?.kind, FailureKind.providerUnavailable);
    });
  });

  group('adding stops (§34, §35)', () {
    setUp(() async {
      await withRoute();
    });

    test('sends the place and its provenance', () async {
      await controller().createFromRoute();
      api.result = trailWithStops(1, revision: 2);

      await controller().addStop('place-1', TrailStopSource.discovery);

      expect(api.addedPlaceIds, <String>['place-1']);
      expect(api.addedSources, <TrailStopSource>[TrailStopSource.discovery]);
      expect(state().trail?.stops, hasLength(1));
    });

    test('records a search-sourced stop distinctly (§35)', () async {
      await controller().createFromRoute();
      api.result = trailWithStops(1, revision: 2);

      await controller().addStop('place-1', TrailStopSource.search);

      expect(api.addedSources.last, TrailStopSource.search);
    });

    test('sends the revision it is editing (§25)', () async {
      api.result = trailFixture(revision: 4);
      await controller().createFromRoute();

      await controller().addStop('place-1', TrailStopSource.search);

      expect(api.revisionsSent.last, 4);
    });

    test('keeps the previous trail when the mutation fails (§83)', () async {
      await controller().createFromRoute();
      final Trail before = state().trail!;

      api.failure = const AppFailure(
        kind: FailureKind.providerUnavailable,
        message: 'Upstream is down.',
      );
      await controller().addStop('place-1', TrailStopSource.search);

      expect(state().trail, before);
      expect(state().failure?.kind, FailureKind.providerUnavailable);
    });

    test('surfaces a duplicate stop distinctly (§33)', () async {
      await controller().createFromRoute();

      api.failure = const AppFailure(
        kind: FailureKind.trailStopDuplicate,
        message: 'Already a stop.',
      );
      await controller().addStop('place-1', TrailStopSource.search);

      expect(state().failure?.kind, FailureKind.trailStopDuplicate);
    });

    test('surfaces the stop ceiling distinctly (§14)', () async {
      await controller().createFromRoute();

      api.failure = const AppFailure(
        kind: FailureKind.trailStopLimitReached,
        message: 'Full.',
      );
      await controller().addStop('place-1', TrailStopSource.search);

      expect(state().failure?.kind, FailureKind.trailStopLimitReached);
    });

    test('refuses a second mutation while one is in flight (§55)', () async {
      await controller().createFromRoute();
      api.latency = const Duration(milliseconds: 40);

      final Future<void> first = controller().addStop(
        'a',
        TrailStopSource.search,
      );
      await controller().addStop('b', TrailStopSource.search);
      await first;

      /* Each change re-routes upstream; a double-tap must not spend two calls. */
      expect(api.addStopCalls, 1);
    });
  });

  group('removing stops (§30)', () {
    test('sends the stop id and the revision', () async {
      await withRoute();
      api.result = trailWithStops(2, revision: 3);
      await controller().createFromRoute();

      api.result = trailWithStops(1, revision: 4);
      await controller().removeStop('stop-1');

      expect(api.removeStopCalls, 1);
      expect(api.revisionsSent.last, 3);
      expect(state().trail?.stops, hasLength(1));
    });
  });

  group('reorder (§55, §56, §95)', () {
    setUp(() async {
      await withRoute();
      api.result = trailWithStops(3, revision: 2);
      await controller().createFromRoute();
    });

    test('produces exactly one mutation for one drag', () async {
      api.result = trailWithStops(3, revision: 3);

      await controller().reorderStops(0, 2);

      /* One request on drop, never one per frame (§95). */
      expect(api.reorderCalls, 1);
    });

    test('sends the whole set in the new order (§31)', () async {
      api.result = trailWithStops(3, revision: 3);

      await controller().reorderStops(0, 2);

      expect(api.reorderedOrders.single, <String>[
        'stop-2',
        'stop-3',
        'stop-1',
      ]);
    });

    test(
      'shows the new order immediately, before the server confirms (§56)',
      () async {
        api
          ..result = trailWithStops(3, revision: 3)
          ..latency = const Duration(milliseconds: 40);

        final Future<void> pending = controller().reorderStops(0, 2);

        /* The list must not snap back under the finger. */
        expect(
          state().trail?.stops.map((TrailStop s) => s.id).toList(),
          <String>['stop-2', 'stop-3', 'stop-1'],
        );
        expect(state().isMutating, isTrue);

        await pending;
      },
    );

    test('renumbers positions in the preview', () async {
      api
        ..result = trailWithStops(3, revision: 3)
        ..latency = const Duration(milliseconds: 30);

      final Future<void> pending = controller().reorderStops(0, 2);

      expect(
        state().trail?.stops.map((TrailStop s) => s.position).toList(),
        <int>[1, 2, 3],
      );

      await pending;
    });

    test('rolls back when the server refuses (§56)', () async {
      final List<String> before = state().trail!.stops
          .map((TrailStop s) => s.id)
          .toList();

      api.failure = const AppFailure(
        kind: FailureKind.providerUnavailable,
        message: 'Upstream is down.',
      );
      await controller().reorderStops(0, 2);

      /* A list that keeps a change the server rejected is lying about what is saved. */
      expect(state().trail?.stops.map((TrailStop s) => s.id).toList(), before);
      expect(state().failure?.kind, FailureKind.providerUnavailable);
    });

    test(
      'rolls back and flags a conflict when the revision moved (§78)',
      () async {
        api.failure = const AppFailure(
          kind: FailureKind.conflict,
          message: 'Changed elsewhere.',
        );

        await controller().reorderStops(0, 2);

        expect(state().conflictDetected, isTrue);
        expect(
          state().trail?.stops.map((TrailStop s) => s.id).toList(),
          <String>['stop-1', 'stop-2', 'stop-3'],
        );
      },
    );

    test('is inert for a drop that changes nothing', () async {
      await controller().reorderStops(1, 1);

      expect(api.reorderCalls, 0);
    });
  });

  group('stale responses (§57)', () {
    test('discards an answer to a superseded request', () async {
      await withRoute();
      await controller().createFromRoute();

      api
        ..result = trailWithStops(1, revision: 2)
        ..latency = const Duration(milliseconds: 120);
      final Future<void> slow = controller().addStop(
        'a',
        TrailStopSource.search,
      );

      controller().close();
      await slow;

      /* A response describing a version older than what is on screen is dropped. */
      expect(state().hasTrail, isFalse);
    });

    test('discards a read that a newer read superseded', () async {
      api.latency = const Duration(milliseconds: 80);
      final Future<void> first = controller().open('trail-1');

      api.result = trailWithStops(2, revision: 9);
      await controller().open('trail-2');
      await first;

      expect(state().trail?.revision, 9);
    });
  });

  group('resume (§69, §116)', () {
    test('restores a whole trail from one read', () async {
      api.result = trailWithStops(2, revision: 5);

      await controller().open('trail-1');

      expect(api.readCalls, 1);
      expect(state().trail?.stops, hasLength(2));
      expect(state().trail?.revision, 5);
      expect(state().trail?.route, isNotNull);
    });

    test('does not recalculate the route just because it was opened', () async {
      api.result = trailWithStops(2, revision: 5);

      await controller().open('trail-1');

      /* The snapshot is what the user saved; re-routing on open would change it. */
      expect(api.recalculateCalls, 0);
    });

    test('reports a failed read without inventing a trail', () async {
      api.failure = const AppFailure(
        kind: FailureKind.unknown,
        message: 'Gone.',
      );

      await controller().open('trail-1');

      expect(state().hasTrail, isFalse);
      expect(state().failure, isNotNull);
    });
  });

  group('lifecycle', () {
    test('finalizes at the current revision (§45)', () async {
      await withRoute();
      api.result = trailFixture(revision: 3);
      await controller().createFromRoute();

      api.result = trailFixture(revision: 3, status: TrailStatus.finalized);
      await controller().finalize();

      expect(api.finalizeCalls, 1);
      expect(api.revisionsSent.last, 3);
      expect(state().trail?.status, TrailStatus.finalized);
    });

    test('refuses to finalize a stale route (§22)', () async {
      await withRoute();
      await controller().createFromRoute();

      api.failure = const AppFailure(
        kind: FailureKind.trailRouteStale,
        message: 'Stale.',
      );
      await controller().finalize();

      expect(state().failure?.kind, FailureKind.trailRouteStale);
    });

    test('recalculates on request (§70)', () async {
      await withRoute();
      await controller().createFromRoute();

      await controller().recalculate();

      expect(api.recalculateCalls, 1);
    });

    test('closing keeps the trail on the server', () async {
      await withRoute();
      await controller().createFromRoute();

      controller().close();

      expect(state().hasTrail, isFalse);
      /* Nothing is deleted: every change was already persisted (§66). */
      expect(api.createCalls, 1);
    });

    test('reloads after a conflict rather than overwriting (§78)', () async {
      api.result = trailWithStops(1, revision: 2);
      await controller().open('trail-1');

      api.result = trailWithStops(3, revision: 7);
      await controller().reloadAfterConflict();

      expect(state().trail?.revision, 7);
      expect(state().conflictDetected, isFalse);
    });
  });
}

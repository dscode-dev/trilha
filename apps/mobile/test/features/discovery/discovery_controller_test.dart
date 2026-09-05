import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/core/errors/app_failure.dart';
import 'package:trilha_mobile/features/discovery/application/discovery_controller.dart';
import 'package:trilha_mobile/features/discovery/application/discovery_providers.dart';
import 'package:trilha_mobile/features/discovery/application/discovery_state.dart';
import 'package:trilha_mobile/features/discovery/domain/route_candidate.dart';
import 'package:trilha_mobile/features/routing/application/routing_controller.dart';
import 'package:trilha_mobile/features/routing/application/routing_providers.dart';

import '../../support/discovery_fakes.dart';
import '../../support/routing_fakes.dart';

/// Discovery state, filters, stale responses and its dependency on a route (§75).
void main() {
  late FakeDiscoveryApi api;
  late FakeRoutingApi routingApi;
  ProviderContainer? active;

  ProviderContainer container() =>
      active ??= discoveryTestContainer(discovery: api, routing: routingApi);

  DiscoveryController controller() =>
      container().read(discoveryControllerProvider.notifier);
  DiscoveryState state() => container().read(discoveryControllerProvider);
  RoutingController routing() =>
      container().read(routingControllerProvider.notifier);

  /// Puts the app in the state discovery requires: a calculated route (§62).
  Future<void> withRoute() async {
    routing()
      ..setOrigin(originEndpoint())
      ..setDestination(destinationEndpoint());
    await routing().calculate();
  }

  setUp(() {
    api = FakeDiscoveryApi();
    routingApi = FakeRoutingApi();
    active = null;
  });

  tearDown(() {
    active?.dispose();
    active = null;
  });

  group('route dependency (§62)', () {
    test('starts idle', () {
      expect(state(), isA<DiscoveryIdle>());
      expect(state().isActive, isFalse);
    });

    test('does nothing without a route', () async {
      await controller().discover();

      /* Discovery cannot invent the journey it is meant to search along. */
      expect(api.calls, 0);
      expect(state(), isA<DiscoveryIdle>());
    });

    test('does nothing when only one endpoint is chosen', () async {
      routing().setOrigin(originEndpoint());
      await controller().discover();

      expect(api.calls, 0);
    });

    test('runs once a route exists and the user asks', () async {
      api.results = <RouteCandidate>[candidate()];
      await withRoute();

      await controller().discover();

      expect(api.calls, 1);
      expect(state(), isA<DiscoverySuccess>());
    });

    test('does not run merely because a route appeared (§65)', () async {
      api.results = <RouteCandidate>[candidate()];
      await withRoute();

      /* Each run costs a route calculation and a matrix call upstream, so it must be
         an explicit action rather than a consequence of a state change. */
      expect(api.calls, 0);
      expect(state(), isA<DiscoveryIdle>());
    });

    test('sends the route endpoints, not a geometry (§9)', () async {
      api.results = <RouteCandidate>[candidate()];
      await withRoute();
      await controller().discover();

      expect(api.originsRequested.single.position, originEndpoint().position);
    });

    test('clears itself when the route is reset', () async {
      api.results = <RouteCandidate>[candidate()];
      await withRoute();
      await controller().discover();
      expect(state(), isA<DiscoverySuccess>());

      routing().reset();
      await Future<void>.delayed(Duration.zero);

      /* Candidates for a journey nobody is taking must not stay on screen. */
      expect(state(), isA<DiscoveryIdle>());
    });

    test('clears itself when an endpoint changes', () async {
      api.results = <RouteCandidate>[candidate()];
      await withRoute();
      await controller().discover();

      routing().setDestination(originEndpoint());
      await Future<void>.delayed(Duration.zero);

      expect(state(), isA<DiscoveryIdle>());
    });
  });

  group('states (§63)', () {
    test('passes through loading', () async {
      api
        ..results = <RouteCandidate>[candidate()]
        ..latency = const Duration(milliseconds: 40);
      await withRoute();

      final Future<void> pending = controller().discover();
      expect(state(), isA<DiscoveryLoading>());
      expect(state().isLoading, isTrue);

      await pending;
      expect(state(), isA<DiscoverySuccess>());
    });

    test('distinguishes empty from success (§52)', () async {
      api.results = <RouteCandidate>[];
      await withRoute();

      await controller().discover();

      /* "Nothing along this route" is an answer and reads differently on screen from
         "here is what we found". */
      expect(state(), isA<DiscoveryEmpty>());
      expect(state().candidates, isEmpty);
    });

    test('reports a failure without losing the filters', () async {
      api.failure = const AppFailure(
        kind: FailureKind.providerUnavailable,
        message: 'Upstream is down.',
      );
      await withRoute();

      await controller().discover(categories: <String>['FOOD']);

      expect(state(), isA<DiscoveryFailure>());
      expect(state().failureOrNull?.kind, FailureKind.providerUnavailable);
      expect(state().categories, <String>['FOOD']);
    });

    test('carries the policy version through', () async {
      api
        ..results = <RouteCandidate>[candidate()]
        ..policyVersion = 'v1';
      await withRoute();

      await controller().discover();

      expect((state() as DiscoverySuccess).policyVersion, 'v1');
    });
  });

  group('category filters (§60)', () {
    test('sends the requested categories', () async {
      api.results = <RouteCandidate>[candidate()];
      await withRoute();

      await controller().setCategories(<String>['FOOD', 'NATURE']);

      expect(api.categoriesRequested.single, <String>['FOOD', 'NATURE']);
    });

    test('toggling adds a category and re-runs', () async {
      api.results = <RouteCandidate>[candidate()];
      await withRoute();
      await controller().discover();

      await controller().toggleCategory('FOOD');

      expect(api.calls, 2);
      expect(api.categoriesRequested.last, <String>['FOOD']);
    });

    test('toggling again removes it', () async {
      api.results = <RouteCandidate>[candidate()];
      await withRoute();
      await controller().toggleCategory('FOOD');

      await controller().toggleCategory('FOOD');

      expect(api.categoriesRequested.last, isEmpty);
    });

    test('reuses the existing route rather than recalculating it', () async {
      api.results = <RouteCandidate>[candidate()];
      await withRoute();
      final int routeCalls = routingApi.calls;

      await controller().toggleCategory('FOOD');

      /* The user has not changed where they are going, so the route stands (§60). */
      expect(routingApi.calls, routeCalls);
    });

    test('keeps the filters visible while a request is in flight', () async {
      api
        ..results = <RouteCandidate>[candidate()]
        ..latency = const Duration(milliseconds: 30);
      await withRoute();

      final Future<void> pending = controller().setCategories(<String>[
        'NATURE',
      ]);
      expect(state().categories, <String>['NATURE']);

      await pending;
      expect(state().categories, <String>['NATURE']);
    });

    test('remembers the filters across a later refresh', () async {
      api.results = <RouteCandidate>[candidate()];
      await withRoute();
      await controller().setCategories(<String>['NATURE']);

      await controller().discover();

      expect(api.categoriesRequested.last, <String>['NATURE']);
    });
  });

  group('stale responses (§64)', () {
    test('a superseded request never overwrites the newer one', () async {
      api.latencies.addAll(const <Duration>[
        Duration(milliseconds: 120),
        Duration(milliseconds: 10),
      ]);
      api.results = <RouteCandidate>[candidate(name: 'Newest')];
      await withRoute();

      final Future<void> first = controller().discover();
      final Future<void> second = controller().setCategories(<String>['FOOD']);
      await Future.wait(<Future<void>>[first, second]);

      expect(api.calls, 2);
      expect(state(), isA<DiscoverySuccess>());
      expect(state().categories, <String>['FOOD']);
    });

    test('a response arriving after a reset is discarded', () async {
      api
        ..results = <RouteCandidate>[candidate()]
        ..latency = const Duration(milliseconds: 60);
      await withRoute();

      final Future<void> pending = controller().discover();
      controller().reset();
      await pending;

      expect(state(), isA<DiscoveryIdle>());
    });

    test('a response arriving after the route changed is discarded', () async {
      api
        ..results = <RouteCandidate>[candidate()]
        ..latency = const Duration(milliseconds: 60);
      await withRoute();

      final Future<void> pending = controller().discover();
      routing().reset();
      await pending;

      expect(state(), isA<DiscoveryIdle>());
      expect(state().candidates, isEmpty);
    });
  });

  group('selection (§57)', () {
    test('highlights a candidate', () async {
      final RouteCandidate first = candidate();
      api.results = <RouteCandidate>[first, candidate()];
      await withRoute();
      await controller().discover();

      controller().select(first.place.id);

      expect(state().selectedPlaceId, first.place.id);
    });

    test('clears the highlight', () async {
      final RouteCandidate first = candidate();
      api.results = <RouteCandidate>[first];
      await withRoute();
      await controller().discover();
      controller().select(first.place.id);

      controller().select(null);

      expect(state().selectedPlaceId, isNull);
    });

    test('costs no request', () async {
      final RouteCandidate first = candidate();
      api.results = <RouteCandidate>[first];
      await withRoute();
      await controller().discover();

      controller().select(first.place.id);

      /* Selection is a view concern; re-querying on a tap would spend money on a
         highlight. */
      expect(api.calls, 1);
    });

    test('keeps the candidates it is selecting within', () async {
      api.results = <RouteCandidate>[candidate(), candidate()];
      await withRoute();
      await controller().discover();

      controller().select(api.results.first.place.id);

      expect(state().candidates, hasLength(2));
    });

    test('is inert before there is anything to select', () {
      controller().select('anything');

      expect(state(), isA<DiscoveryIdle>());
    });
  });
}

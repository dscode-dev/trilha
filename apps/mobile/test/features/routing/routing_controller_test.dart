import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/core/errors/app_failure.dart';
import 'package:trilha_mobile/features/map/application/location_service.dart';
import 'package:trilha_mobile/features/routing/application/routing_controller.dart';
import 'package:trilha_mobile/features/routing/application/routing_providers.dart';
import 'package:trilha_mobile/features/routing/application/routing_state.dart';
import 'package:trilha_mobile/features/routing/domain/route.dart';

import '../../support/places_fakes.dart';
import '../../support/routing_fakes.dart';

/// Endpoint selection, request lifecycle, swap, reset and stale responses (§66).
void main() {
  late FakeRoutingApi api;
  late FakeLocationService location;
  ProviderContainer? active;

  ProviderContainer container() =>
      active ??= routingTestContainer(routing: api, location: location);

  RoutingController controller() =>
      container().read(routingControllerProvider.notifier);
  RoutingState state() => container().read(routingControllerProvider);

  setUp(() {
    api = FakeRoutingApi();
    location = FakeLocationService();
    active = null;
  });

  tearDown(() {
    active?.dispose();
    active = null;
  });

  group('endpoint selection', () {
    test('starts idle with nothing selected', () {
      expect(state(), isA<RoutingIdle>());
      expect(state().origin, isNull);
      expect(state().destination, isNull);
      expect(state().isActive, isFalse);
    });

    test('one endpoint is not enough to calculate', () {
      controller().setOrigin(originEndpoint());

      expect(state(), isA<RoutingSelecting>());
      expect(state().hasBothEndpoints, isFalse);
      expect(state().canCalculate, isFalse);
    });

    test('both endpoints make the route requestable', () {
      controller()
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint());

      expect(state(), isA<RoutingReady>());
      expect(state().canCalculate, isTrue);
    });

    test('selecting endpoints requests nothing on its own', () {
      controller()
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint());

      expect(
        api.calls,
        0,
        reason: 'routing costs money upstream; only the user starts a request',
      );
    });

    test('a Place selection carries its id through to the request', () async {
      controller()
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint());
      await controller().calculate();

      expect(api.requests.single.destination.placeId, 'olinda-id');
      expect(
        api.requests.single.origin.placeId,
        isNull,
        reason: 'a point picked on the map is not a Place',
      );
    });

    test('changing an endpoint discards the route already drawn', () async {
      controller()
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint());
      await controller().calculate();
      expect(state(), isA<RoutingSuccess>());

      controller().setDestination(
        const RouteEndpoint(position: kIgrejaDaSe, label: 'Igreja da Sé'),
      );

      expect(state(), isA<RoutingReady>());
      expect(state().routeOrNull, isNull);
    });
  });

  group('current location as origin', () {
    test('uses the device position when permission is granted', () async {
      location
        ..permission = LocationAvailability.granted
        ..position = (latitude: -8.05, longitude: -34.88);

      final bool located = await controller().useCurrentLocationAsOrigin();

      expect(located, isTrue);
      expect(state().origin?.position.latitude, -8.05);
      expect(state().origin?.label, 'Your location');
    });

    test(
      'reports failure without blocking route building when denied',
      () async {
        location.permission = LocationAvailability.denied;

        final bool located = await controller().useCurrentLocationAsOrigin();

        expect(located, isFalse);
        expect(state().origin, isNull);
        expect(
          state(),
          isA<RoutingIdle>(),
          reason: 'the user can still pick a point on the map',
        );
      },
    );
  });

  group('calculation', () {
    test('does nothing without both endpoints', () async {
      controller().setOrigin(originEndpoint());
      await controller().calculate();

      expect(api.calls, 0);
      expect(state(), isA<RoutingSelecting>());
    });

    test('passes through loading and lands on success', () async {
      api.latency = const Duration(milliseconds: 40);
      controller()
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint());

      final Future<void> pending = controller().calculate();
      expect(state(), isA<RoutingLoading>());
      expect(state().isLoading, isTrue);

      await pending;
      expect(state(), isA<RoutingSuccess>());
      expect(state().routeOrNull?.distanceMeters, 121000);
      expect(state().routeOrNull?.geometry.length, greaterThanOrEqualTo(2));
    });

    test('keeps the endpoints after a provider failure', () async {
      api.failure = const AppFailure(
        kind: FailureKind.providerUnavailable,
        message: 'Provider unavailable.',
      );
      controller()
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint());
      await controller().calculate();

      expect(state(), isA<RoutingFailure>());
      expect(state().failureOrNull?.kind, FailureKind.providerUnavailable);
      expect(state().origin, originEndpoint());
      expect(state().destination, destinationEndpoint());
      expect(
        state().canCalculate,
        isTrue,
        reason: 'a failed attempt must be retryable without re-entering points',
      );
    });

    test('surfaces "no route" distinctly from a transport failure', () async {
      api.failure = const AppFailure(
        kind: FailureKind.notRoutable,
        message: 'No route.',
      );
      controller()
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint());
      await controller().calculate();

      expect(state().failureOrNull?.kind, FailureKind.notRoutable);
    });

    test('never persists anything between resets', () async {
      controller()
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint());
      await controller().calculate();
      controller().reset();

      expect(state(), isA<RoutingIdle>());
      expect(state().routeOrNull, isNull);
      expect(state().origin, isNull);
      expect(state().destination, isNull);
    });
  });

  group('stale responses', () {
    test('a superseded request never overwrites the newer one', () async {
      /* The first call is slow, the second fast: without sequencing the slow one
         would land last and draw the wrong route (§43). */
      api.latencies.addAll(const <Duration>[
        Duration(milliseconds: 120),
        Duration(milliseconds: 10),
      ]);
      api.result = sampleRoute(distanceMeters: 111);

      controller()
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint());

      final Future<void> first = controller().calculate();
      final Future<void> second = controller().calculate();
      await Future.wait(<Future<void>>[first, second]);

      expect(api.calls, 2);
      expect(state(), isA<RoutingSuccess>());
      expect(state().routeOrNull?.distanceMeters, 111);
    });

    test('a response arriving after a reset is discarded', () async {
      api.latency = const Duration(milliseconds: 60);
      controller()
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint());

      final Future<void> pending = controller().calculate();
      controller().reset();
      await pending;

      expect(state(), isA<RoutingIdle>());
      expect(state().routeOrNull, isNull);
    });

    test('a response arriving after an endpoint change is discarded', () async {
      api.latency = const Duration(milliseconds: 60);
      controller()
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint());

      final Future<void> pending = controller().calculate();
      controller().setOrigin(
        const RouteEndpoint(position: kIgrejaDaSe, label: 'Igreja da Sé'),
      );
      await pending;

      expect(state(), isA<RoutingReady>());
      expect(state().routeOrNull, isNull);
    });
  });

  group('swap', () {
    test('exchanges the endpoints', () {
      controller()
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint())
        ..swap();

      expect(state().origin, destinationEndpoint());
      expect(state().destination, originEndpoint());
    });

    test('does not recalculate on its own', () async {
      controller()
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint());
      await controller().calculate();
      final int before = api.calls;

      controller().swap();

      expect(api.calls, before);
      expect(
        state(),
        isA<RoutingReady>(),
        reason: 'the previous route no longer describes the current endpoints',
      );
    });

    test('is inert with only one endpoint', () {
      controller()
        ..setOrigin(originEndpoint())
        ..swap();

      expect(state().origin, originEndpoint());
      expect(state().destination, isNull);
    });
  });
}

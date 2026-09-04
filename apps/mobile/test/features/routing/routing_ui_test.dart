import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/app/theme/app_theme.dart';
import 'package:trilha_mobile/core/errors/app_failure.dart';
import 'package:trilha_mobile/features/routing/application/routing_controller.dart';
import 'package:trilha_mobile/features/routing/application/routing_providers.dart';
import 'package:trilha_mobile/features/routing/domain/route.dart';
import 'package:trilha_mobile/features/routing/presentation/route_panel.dart';

import '../../support/routing_fakes.dart';

/// The route-building surface (§66).
///
/// The Mapbox platform view cannot render in a test binding, so the line drawing is
/// covered through the [RouteOverlay] seam rather than here (§63).
void main() {
  Widget host(ProviderContainer container, {Widget? panel}) =>
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.light(),
          home: Scaffold(
            body:
                panel ??
                RoutePanel(onPickOrigin: () {}, onPickDestination: () {}),
          ),
        ),
      );

  group('RoutePanel (§32, §39)', () {
    testWidgets('invites both endpoints before anything is chosen', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = routingTestContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(host(container));

      expect(find.text('Choose a starting point'), findsOneWidget);
      expect(find.text('Choose a destination'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
        reason: 'nothing can be routed yet',
      );
    });

    testWidgets('reports the tapped slot to the host', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = routingTestContainer();
      addTearDown(container.dispose);

      final List<String> picked = <String>[];
      await tester.pumpWidget(
        host(
          container,
          panel: RoutePanel(
            onPickOrigin: () => picked.add('origin'),
            onPickDestination: () => picked.add('destination'),
          ),
        ),
      );

      await tester.tap(find.text('Choose a destination'));
      await tester.tap(find.text('Choose a starting point'));

      expect(picked, <String>['destination', 'origin']);
    });

    testWidgets('labels endpoints with letters, not colour alone (§38)', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = routingTestContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(host(container));

      expect(find.text('A'), findsOneWidget);
      expect(find.text('B'), findsOneWidget);
    });

    testWidgets(
      'shows a chosen Place by name and a tapped point by coordinates',
      (WidgetTester tester) async {
        final ProviderContainer container = routingTestContainer();
        addTearDown(container.dispose);
        await tester.pumpWidget(host(container));

        container.read(routingControllerProvider.notifier)
          ..setOrigin(const RouteEndpoint(position: kOlinda))
          ..setDestination(destinationEndpoint());
        await tester.pump();

        expect(find.text('Olinda'), findsOneWidget);
        expect(find.text('-7.9939, -34.8455'), findsOneWidget);
      },
    );

    testWidgets('enables the request only once both endpoints exist (§35)', (
      WidgetTester tester,
    ) async {
      final FakeRoutingApi api = FakeRoutingApi();
      final ProviderContainer container = routingTestContainer(routing: api);
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));

      container
          .read(routingControllerProvider.notifier)
          .setOrigin(originEndpoint());
      await tester.pump();
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );

      container
          .read(routingControllerProvider.notifier)
          .setDestination(destinationEndpoint());
      await tester.pump();
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNotNull,
      );
      expect(api.calls, 0, reason: 'selection alone requests nothing');
    });

    testWidgets(
      'shows progress while calculating, then distance and duration',
      (WidgetTester tester) async {
        final FakeRoutingApi api = FakeRoutingApi()
          ..latency = const Duration(milliseconds: 50);
        final ProviderContainer container = routingTestContainer(routing: api);
        addTearDown(container.dispose);
        await tester.pumpWidget(host(container));

        container.read(routingControllerProvider.notifier)
          ..setOrigin(originEndpoint())
          ..setDestination(destinationEndpoint());
        await tester.pump();

        await tester.tap(find.text('Get route'));
        await tester.pump();
        expect(find.byType(CircularProgressIndicator), findsOneWidget);

        await tester.pump(const Duration(milliseconds: 60));
        expect(find.byType(CircularProgressIndicator), findsNothing);
        expect(find.text('121 km'), findsOneWidget);
        expect(find.text('1h48'), findsOneWidget);
        expect(find.text('Recalculate'), findsOneWidget);
        expect(api.calls, 1);
      },
    );

    testWidgets('explains a failure in words and keeps the endpoints (§56)', (
      WidgetTester tester,
    ) async {
      final FakeRoutingApi api = FakeRoutingApi()
        ..failure = const AppFailure(
          kind: FailureKind.notRoutable,
          message: 'No route.',
        );
      final ProviderContainer container = routingTestContainer(routing: api);
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));

      container.read(routingControllerProvider.notifier)
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint());
      await tester.pump();

      await tester.tap(find.text('Get route'));
      await tester.pumpAndSettle();

      expect(
        find.text('No driving route connects those two points.'),
        findsOneWidget,
      );
      expect(find.text('Olinda'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNotNull,
        reason: 'retry must not require re-entering the endpoints',
      );
    });

    testWidgets('swap exchanges the fields without requesting (§40)', (
      WidgetTester tester,
    ) async {
      final FakeRoutingApi api = FakeRoutingApi();
      final ProviderContainer container = routingTestContainer(routing: api);
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));

      container.read(routingControllerProvider.notifier)
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint());
      await tester.pump();

      await tester.tap(find.byIcon(Icons.swap_vert));
      await tester.pump();

      final RoutingController controller = container.read(
        routingControllerProvider.notifier,
      );
      expect(container.read(routingControllerProvider).origin?.label, 'Olinda');
      expect(api.calls, 0);
      controller.reset();
    });

    testWidgets('swap is disabled until both endpoints exist', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = routingTestContainer();
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));

      expect(
        tester.widget<IconButton>(find.byType(IconButton)).onPressed,
        isNull,
      );
    });

    testWidgets('clear empties the panel completely (§41)', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = routingTestContainer();
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));

      container.read(routingControllerProvider.notifier)
        ..setOrigin(originEndpoint())
        ..setDestination(destinationEndpoint());
      await tester.pump();

      await tester.tap(find.text('Clear'));
      await tester.pump();

      expect(find.text('Choose a starting point'), findsOneWidget);
      expect(find.text('Olinda'), findsNothing);
      expect(find.text('Clear'), findsNothing);
    });
  });

  group('formatting (§15)', () {
    test('durations read the way a driver would say them', () {
      expect(formatDuration(45), '45s');
      expect(formatDuration(600), '10min');
      expect(formatDuration(3600), '1h');
      expect(formatDuration(6480), '1h48');
      expect(formatDuration(3660), '1h01');
    });

    test('distances drop precision as they grow', () {
      expect(formatRouteDistance(850), '850 m');
      expect(formatRouteDistance(1500), '1.5 km');
      expect(formatRouteDistance(121000), '121 km');
    });
  });

  group('failure messages (§56)', () {
    test('never leak a status code or an exception type', () {
      for (final FailureKind kind in FailureKind.values) {
        final String message = routeFailureMessage(
          AppFailure(kind: kind, message: 'raw: 502 DioException'),
        );

        expect(message, isNot(contains('502')));
        expect(message, isNot(contains('Exception')));
        expect(
          message.endsWith('.'),
          isTrue,
          reason: '$kind reads as a sentence',
        );
      }
    });

    test('distinguishes an unroutable pair from an unavailable provider', () {
      const AppFailure notRoutable = AppFailure(
        kind: FailureKind.notRoutable,
        message: '',
      );
      const AppFailure unavailable = AppFailure(
        kind: FailureKind.providerUnavailable,
        message: '',
      );

      expect(
        routeFailureMessage(notRoutable),
        isNot(routeFailureMessage(unavailable)),
      );
    });
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/app/theme/app_theme.dart';
import 'package:trilha_mobile/core/errors/app_failure.dart';
import 'package:trilha_mobile/features/discovery/application/discovery_providers.dart';
import 'package:trilha_mobile/features/discovery/application/discovery_state.dart';
import 'package:trilha_mobile/features/discovery/domain/route_candidate.dart';
import 'package:trilha_mobile/features/discovery/presentation/discovery_sheet.dart';
import 'package:trilha_mobile/features/routing/application/routing_providers.dart';

import '../../support/discovery_fakes.dart';
import '../../support/routing_fakes.dart';

/// The "Descobertas pelo caminho" surface (§55, §58, §59, §75).
void main() {
  Widget host(ProviderContainer container, {Widget? child}) =>
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.light(),
          home: Scaffold(body: child ?? const DiscoverySheet()),
        ),
      );

  /// Calculates a route, which is the precondition for discovery (§62).
  Future<void> withRoute(ProviderContainer container) async {
    final routing = container.read(routingControllerProvider.notifier)
      ..setOrigin(originEndpoint())
      ..setDestination(destinationEndpoint());
    await routing.calculate();
  }

  group('DiscoverySheet states (§63)', () {
    testWidgets('invites a route before there is one', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = discoveryTestContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(host(container));

      expect(
        find.text('Calcule uma rota para ver o que há pelo caminho.'),
        findsOneWidget,
      );
    });

    testWidgets('shows progress while searching', (WidgetTester tester) async {
      final FakeDiscoveryApi api = FakeDiscoveryApi()
        ..results = <RouteCandidate>[candidate()]
        ..latency = const Duration(milliseconds: 50);
      final ProviderContainer container = discoveryTestContainer(
        discovery: api,
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(host(container));
      await withRoute(container);

      unawaitedDiscover(container);
      await tester.pump();
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      await tester.pump(const Duration(milliseconds: 60));
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('lists candidates on success', (WidgetTester tester) async {
      final FakeDiscoveryApi api = FakeDiscoveryApi()
        ..results = <RouteCandidate>[
          candidate(name: 'Museu do Homem'),
          candidate(name: 'Restaurante Boa Viagem', detourSeconds: 540),
        ];
      final ProviderContainer container = discoveryTestContainer(
        discovery: api,
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(host(container));
      await withRoute(container);
      await container.read(discoveryControllerProvider.notifier).discover();
      await tester.pump();

      expect(find.text('Museu do Homem'), findsOneWidget);
      expect(find.text('Restaurante Boa Viagem'), findsOneWidget);
      expect(find.byType(CandidateCard), findsNWidgets(2));
    });

    testWidgets('says nothing was found without reading as an error (§52)', (
      WidgetTester tester,
    ) async {
      final FakeDiscoveryApi api = FakeDiscoveryApi()
        ..results = <RouteCandidate>[];
      final ProviderContainer container = discoveryTestContainer(
        discovery: api,
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(host(container));
      await withRoute(container);
      await container.read(discoveryControllerProvider.notifier).discover();
      await tester.pump();

      expect(
        find.text('Nada por perto dentro do desvio que você aceita.'),
        findsOneWidget,
      );
      expect(find.byIcon(Icons.error_outline), findsNothing);
    });

    testWidgets('explains a failure and offers a retry (§56)', (
      WidgetTester tester,
    ) async {
      final FakeDiscoveryApi api = FakeDiscoveryApi()
        ..failure = const AppFailure(
          kind: FailureKind.providerUnavailable,
          message: 'Upstream is down.',
        );
      final ProviderContainer container = discoveryTestContainer(
        discovery: api,
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(host(container));
      await withRoute(container);
      await container.read(discoveryControllerProvider.notifier).discover();
      await tester.pump();

      expect(
        find.text(
          'As descobertas estão indisponíveis agora. Tente de novo em instantes.',
        ),
        findsOneWidget,
      );

      await tester.tap(find.text('Tentar de novo'));
      await tester.pump();
      expect(api.calls, 2);
    });
  });

  group('CandidateCard (§58, §59)', () {
    testWidgets('shows the extra time, never the score', (
      WidgetTester tester,
    ) async {
      final FakeDiscoveryApi api = FakeDiscoveryApi()
        ..results = <RouteCandidate>[
          candidate(
            name: 'Mirante',
            detourSeconds: 420,
            relevanceScore: 0.91423,
          ),
        ];
      final ProviderContainer container = discoveryTestContainer(
        discovery: api,
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(host(container));
      await withRoute(container);
      await container.read(discoveryControllerProvider.notifier).discover();
      await tester.pump();

      expect(find.text('+7 min'), findsOneWidget);
      /* A score invites comparisons across policy versions that are not comparable. */
      expect(find.textContaining('0.91'), findsNothing);
      expect(find.textContaining('91%'), findsNothing);
    });

    testWidgets('shows a plain-language reason, not a code (§35)', (
      WidgetTester tester,
    ) async {
      final FakeDiscoveryApi api = FakeDiscoveryApi()
        ..results = <RouteCandidate>[
          candidate(
            name: 'Mirante',
            reasons: const <RelevanceReason>[RelevanceReason.onRoute],
          ),
        ];
      final ProviderContainer container = discoveryTestContainer(
        discovery: api,
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(host(container));
      await withRoute(container);
      await container.read(discoveryControllerProvider.notifier).discover();
      await tester.pump();

      expect(
        find.textContaining('Praticamente no seu caminho'),
        findsOneWidget,
      );
      expect(find.textContaining('ON_ROUTE'), findsNothing);
    });

    testWidgets('shows no rating, safety or popularity (§58, §87)', (
      WidgetTester tester,
    ) async {
      final FakeDiscoveryApi api = FakeDiscoveryApi()
        ..results = <RouteCandidate>[candidate(name: 'Mirante')];
      final ProviderContainer container = discoveryTestContainer(
        discovery: api,
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(host(container));
      await withRoute(container);
      await container.read(discoveryControllerProvider.notifier).discover();
      await tester.pump();

      /* None of these signals exist in the product yet. */
      expect(find.byIcon(Icons.star), findsNothing);
      expect(find.byIcon(Icons.star_border), findsNothing);
      expect(find.textContaining('recomendado'), findsNothing);
      expect(find.textContaining('avaliaç'), findsNothing);
    });

    testWidgets('selecting a card marks it and tells the host (§57)', (
      WidgetTester tester,
    ) async {
      final RouteCandidate first = candidate(name: 'Museu');
      final FakeDiscoveryApi api = FakeDiscoveryApi()
        ..results = <RouteCandidate>[first, candidate(name: 'Mirante')];
      final ProviderContainer container = discoveryTestContainer(
        discovery: api,
      );
      addTearDown(container.dispose);

      final List<String> tapped = <String>[];
      await tester.pumpWidget(
        host(
          container,
          child: DiscoverySheet(
            onCandidateTap: (RouteCandidate c) => tapped.add(c.place.name),
          ),
        ),
      );
      await withRoute(container);
      await container.read(discoveryControllerProvider.notifier).discover();
      await tester.pump();

      await tester.tap(find.text('Museu'));
      await tester.pump();

      expect(tapped, <String>['Museu']);
      expect(
        container.read(discoveryControllerProvider).selectedPlaceId,
        first.place.id,
      );
    });

    testWidgets('a selected card is marked by outline, not colour alone', (
      WidgetTester tester,
    ) async {
      final RouteCandidate first = candidate(name: 'Museu');
      final FakeDiscoveryApi api = FakeDiscoveryApi()
        ..results = <RouteCandidate>[first];
      final ProviderContainer container = discoveryTestContainer(
        discovery: api,
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(host(container));
      await withRoute(container);
      await container.read(discoveryControllerProvider.notifier).discover();
      await tester.pump();

      await tester.tap(find.text('Museu'));
      await tester.pump();

      final Card card = tester.widget<Card>(find.byType(Card).first);
      final RoundedRectangleBorder shape =
          card.shape! as RoundedRectangleBorder;
      expect(shape.side.width, greaterThan(0));
    });
  });

  group('category filters (§60)', () {
    testWidgets('offers the real Place categories, not a second list (§23)', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = discoveryTestContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(host(container));
      await tester.pumpAndSettle();

      /* The fake Places API serves the same taxonomy the app uses everywhere. */
      expect(find.widgetWithText(FilterChip, 'Landmark'), findsOneWidget);
      expect(find.widgetWithText(FilterChip, 'Food & drink'), findsOneWidget);
    });

    testWidgets('tapping a chip re-runs discovery with that category', (
      WidgetTester tester,
    ) async {
      final FakeDiscoveryApi api = FakeDiscoveryApi()
        ..results = <RouteCandidate>[candidate()];
      final ProviderContainer container = discoveryTestContainer(
        discovery: api,
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(host(container));
      await withRoute(container);
      await container.read(discoveryControllerProvider.notifier).discover();
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilterChip, 'Food & drink'));
      await tester.pumpAndSettle();

      expect(api.calls, 2);
      expect(api.categoriesRequested.last, <String>['FOOD']);
    });

    testWidgets('chips are inert while a request is in flight (§65)', (
      WidgetTester tester,
    ) async {
      final FakeDiscoveryApi api = FakeDiscoveryApi()
        ..results = <RouteCandidate>[candidate()]
        ..latency = const Duration(milliseconds: 80);
      final ProviderContainer container = discoveryTestContainer(
        discovery: api,
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(host(container));
      await withRoute(container);
      await tester.pumpAndSettle();

      unawaitedDiscover(container);
      await tester.pump();

      final FilterChip chip = tester.widget<FilterChip>(
        find.widgetWithText(FilterChip, 'Food & drink'),
      );
      /* Queueing a second run would spend another route calculation and matrix call. */
      expect(chip.onSelected, isNull);

      await tester.pump(const Duration(milliseconds: 100));
    });
  });

  group('formatting (§59)', () {
    test('reads a detour the way a driver would say it', () {
      expect(formatDetour(30), 'quase sem desvio');
      expect(formatDetour(420), '+7 min');
      expect(formatDetour(3600), '+1h');
      expect(formatDetour(4500), '+1h15');
    });

    test('never exposes a relevance score', () {
      expect(formatDetour(420), isNot(contains('0.')));
    });
  });

  group('reason mapping (§35)', () {
    test('prefers the most specific explanation', () {
      final RouteCandidate onRoute = candidate(
        reasons: const <RelevanceReason>[
          RelevanceReason.onRoute,
          RelevanceReason.lowDetour,
        ],
      );

      expect(candidateReason(onRoute), 'Praticamente no seu caminho');
    });

    test('falls back through the available codes', () {
      expect(
        candidateReason(
          candidate(
            reasons: const <RelevanceReason>[RelevanceReason.lowDetour],
          ),
        ),
        'Pouco desvio da rota',
      );
      expect(
        candidateReason(
          candidate(
            reasons: const <RelevanceReason>[RelevanceReason.veryCloseToRoute],
          ),
        ),
        'Bem perto da rota',
      );
    });

    test('says nothing rather than inventing a reason', () {
      expect(
        candidateReason(
          candidate(
            reasons: const <RelevanceReason>[RelevanceReason.goodRoutePosition],
          ),
        ),
        isNull,
      );
    });

    test('degrades an unrecognised server code to silence', () {
      /* A reason added server-side must not break a screen that predates it. */
      expect(
        RelevanceReason.fromCode('SOMETHING_NEW'),
        RelevanceReason.unknown,
      );
      expect(
        candidateReason(
          candidate(reasons: const <RelevanceReason>[RelevanceReason.unknown]),
        ),
        isNull,
      );
    });
  });

  group('failure messages (§56)', () {
    test('never leak a status code or an exception type', () {
      for (final FailureKind kind in FailureKind.values) {
        final String message = discoveryFailureMessage(
          AppFailure(kind: kind, message: 'raw: 502 DioException'),
        );

        expect(message, isNot(contains('502')));
        expect(message, isNot(contains('Exception')));
      }
    });
  });
}

/// Starts a discovery without awaiting it, so a test can observe the loading state.
void unawaitedDiscover(ProviderContainer container) {
  container.read(discoveryControllerProvider.notifier).discover().ignore();
}

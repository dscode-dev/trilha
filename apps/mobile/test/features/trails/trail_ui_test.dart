import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/app/theme/app_theme.dart';
import 'package:trilha_mobile/core/errors/app_failure.dart';
import 'package:trilha_mobile/features/trails/application/trail_providers.dart';
import 'package:trilha_mobile/features/trails/domain/trail.dart';
import 'package:trilha_mobile/features/trails/presentation/my_trails_screen.dart';
import 'package:trilha_mobile/features/trails/presentation/trail_builder_sheet.dart';

import '../../support/trail_fakes.dart';

/// The Trail Builder surface (§59, §62, §94, §95).
void main() {
  Widget host(ProviderContainer container, {Widget? child}) =>
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.light(),
          home: Scaffold(body: child ?? const TrailBuilderSheet()),
        ),
      );

  /// Puts a trail into the controller without going through creation.
  Future<void> loadTrail(
    WidgetTester tester,
    ProviderContainer container,
    FakeTrailsApi api,
    Trail trail,
  ) async {
    api.result = trail;
    await container.read(trailControllerProvider.notifier).open(trail.id);
    await tester.pump();
  }

  group('TrailBuilderSheet (§59)', () {
    testWidgets('shows nothing before a trail exists', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = trailTestContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(host(container));

      expect(find.text('Minha trilha'), findsNothing);
    });

    testWidgets('states the endpoints and the totals (§38)', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi();
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));

      await loadTrail(
        tester,
        container,
        api,
        trailFixture(
          detour: const TrailMetrics(
            distanceMeters: 24_000,
            durationSeconds: 1_380,
          ),
        ),
      );

      expect(find.text('Minha trilha'), findsOneWidget);
      expect(find.text('Recife → João Pessoa'), findsOneWidget);
      expect(find.text('145 km · 2h11 · +23min'), findsOneWidget);
    });

    testWidgets('says a trail with no stops still goes A to B (§45)', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi();
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));

      await loadTrail(tester, container, api, trailFixture());

      expect(
        find.text('Nenhuma parada ainda. A trilha vai direto de A a B.'),
        findsOneWidget,
      );
    });

    testWidgets('numbers the stops in visiting order (§62)', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi();
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));

      await loadTrail(tester, container, api, trailWithStops(3));

      /* The order, not the category icon: "which one is third" is the question the
         user is asking while the builder is open. */
      expect(find.text('1'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
      expect(find.text('3'), findsOneWidget);
      expect(find.text('Parada 2'), findsOneWidget);
    });

    testWidgets('removing a stop sends one mutation', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi();
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));
      await loadTrail(tester, container, api, trailWithStops(2));

      api.result = trailWithStops(1, revision: 2);
      await tester.tap(find.byTooltip('Remover Parada 1'));
      await tester.pumpAndSettle();

      expect(api.removeStopCalls, 1);
    });

    testWidgets(
      'says the trail saves itself, and offers no save button (§66)',
      (WidgetTester tester) async {
        final FakeTrailsApi api = FakeTrailsApi();
        final ProviderContainer container = trailTestContainer(trails: api);
        addTearDown(container.dispose);
        await tester.pumpWidget(host(container));

        await loadTrail(tester, container, api, trailFixture());

        /* Every change is already persisted; a save button would imply otherwise. */
        expect(find.text('Salva automaticamente'), findsOneWidget);
        expect(find.widgetWithText(FilledButton, 'Salvar'), findsNothing);
      },
    );

    testWidgets('finalizes only when the route matches the composition (§22)', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi();
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));

      await loadTrail(
        tester,
        container,
        api,
        trailFixture(routeIsCurrent: false),
      );
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, 'Concluir'))
            .onPressed,
        isNull,
      );
      expect(find.text('Atualizar rota'), findsOneWidget);

      await loadTrail(tester, container, api, trailFixture());
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, 'Concluir'))
            .onPressed,
        isNotNull,
      );
    });

    testWidgets('finalizing does not offer publication (§71, §72)', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi();
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));

      await loadTrail(
        tester,
        container,
        api,
        trailFixture(status: TrailStatus.finalized),
      );

      expect(find.text('Trilha concluída'), findsOneWidget);
      /* Publication is a later PR. Nothing here may suggest it exists. */
      expect(find.textContaining('Publicar'), findsNothing);
      expect(find.textContaining('Compartilhar'), findsNothing);
      expect(find.byIcon(Icons.share), findsNothing);
    });

    testWidgets('stops accepting changes while one is in flight (§55)', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi();
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));
      await loadTrail(tester, container, api, trailWithStops(2));

      /* Held open by a completer rather than a delay. `Future.delayed` runs on the
         test binding's fake clock, which only advances while the tester pumps — so a
         test that awaits one without pumping deadlocks until the ten-minute cap. A
         completer needs no clock at all. */
      api.gate = Completer<void>();
      unawaited(
        container.read(trailControllerProvider.notifier).removeStop('stop-1'),
      );
      await tester.pump();

      expect(find.byType(LinearProgressIndicator), findsOneWidget);
      expect(
        tester
            .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, 'Adicionar parada'),
            )
            .onPressed,
        isNull,
      );

      api.gate?.complete();
      /* `pump`, not `pumpAndSettle`: an indeterminate progress indicator animates
         forever, so settling never arrives. */
      await tester.pump();
      await tester.pump();

      expect(find.byType(LinearProgressIndicator), findsNothing);
    }, timeout: const Timeout(Duration(seconds: 30)));

    testWidgets('shows the stop ceiling once it is reached (§14)', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi();
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));

      await loadTrail(
        tester,
        container,
        api,
        trailFixture(
          maxStops: 2,
          stops: <TrailStop>[stopFixture(), stopFixture(position: 2)],
        ),
      );

      expect(find.text('Limite de 2 paradas'), findsOneWidget);
    });

    testWidgets('a conflict offers a reload, not a retry (§78)', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi();
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));
      await loadTrail(tester, container, api, trailWithStops(2));

      api.failure = const AppFailure(
        kind: FailureKind.conflict,
        message: 'Changed.',
      );
      await container
          .read(trailControllerProvider.notifier)
          .removeStop('stop-1');
      await tester.pump();

      expect(find.textContaining('mudou em outro lugar'), findsOneWidget);
      expect(find.text('Recarregar'), findsOneWidget);

      api
        ..failure = null
        ..result = trailWithStops(3, revision: 9);
      await tester.tap(find.text('Recarregar'));
      await tester.pumpAndSettle();

      expect(container.read(trailControllerProvider).trail?.revision, 9);
    });

    testWidgets('says when a trail has no route yet (§26)', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi();
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));

      await loadTrail(
        tester,
        container,
        api,
        trailFixture(withRoute: false, routeIsCurrent: false),
      );

      expect(find.text('Rota ainda não calculada'), findsOneWidget);
    });
  });

  /// The reorder gate (§95).
  group('reorder gesture (§95)', () {
    testWidgets('one completed drag produces exactly one mutation', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi();
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);
      await tester.pumpWidget(host(container));
      await loadTrail(tester, container, api, trailWithStops(3));

      api.result = trailWithStops(3, revision: 2);

      /* Drag the first stop's handle down past the second, in many small steps — the
         same way a finger moves. Every frame must not be a request (§55). */
      final Finder handle = find.byIcon(Icons.drag_handle).first;
      final TestGesture gesture = await tester.startGesture(
        tester.getCenter(handle),
      );
      await tester.pump(kLongPressTimeout);

      for (int i = 0; i < 10; i += 1) {
        await gesture.moveBy(const Offset(0, 12));
        await tester.pump(const Duration(milliseconds: 16));
      }

      await gesture.up();
      await tester.pumpAndSettle();

      expect(api.reorderCalls, 1);
    });
  });

  group('MyTrailsScreen (§68)', () {
    Widget listHost(
      ProviderContainer container, {
      void Function(String)? onOpen,
    }) => UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: AppTheme.light(),
        home: MyTrailsScreen(onOpen: onOpen),
      ),
    );

    TrailSummary summary({
      String id = 'trail-1',
      TrailStatus status = TrailStatus.draft,
      int stopCount = 3,
    }) => TrailSummary(
      id: id,
      status: status,
      originLabel: 'Recife',
      destinationLabel: 'João Pessoa',
      stopCount: stopCount,
      distanceMeters: 145_000,
      durationSeconds: 7_860,
      revision: 4,
      updatedAt: DateTime.utc(2026, 9, 5),
    );

    testWidgets('lists trails with their endpoints and totals', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi()
        ..listResult = <TrailSummary>[summary()];
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);

      await tester.pumpWidget(listHost(container));
      await tester.pumpAndSettle();

      expect(find.text('Recife → João Pessoa'), findsOneWidget);
      expect(find.text('3 paradas · 145 km · 2h11'), findsOneWidget);
    });

    testWidgets('says so when there are none', (WidgetTester tester) async {
      final ProviderContainer container = trailTestContainer(
        trails: FakeTrailsApi(),
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(listHost(container));
      await tester.pumpAndSettle();

      expect(
        find.text('Você ainda não montou nenhuma trilha.'),
        findsOneWidget,
      );
    });

    testWidgets('reports a failed load with a retry', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi()
        ..failure = const AppFailure(
          kind: FailureKind.networkUnavailable,
          message: 'Sem conexão.',
        );
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);

      await tester.pumpWidget(listHost(container));
      await tester.pumpAndSettle();

      expect(find.text('Sem conexão.'), findsOneWidget);
      expect(find.text('Tentar de novo'), findsOneWidget);
    });

    testWidgets('opening one hands the id back to the host (§69)', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi()
        ..listResult = <TrailSummary>[summary(id: 'trail-42')];
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);

      final List<String> opened = <String>[];
      await tester.pumpWidget(listHost(container, onOpen: opened.add));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Recife → João Pessoa'));
      await tester.pump();

      expect(opened, <String>['trail-42']);
    });

    testWidgets('is a private list, not a feed (§5, §72)', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi()
        ..listResult = <TrailSummary>[summary()];
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);

      await tester.pumpWidget(listHost(container));
      await tester.pumpAndSettle();

      /* No author, no like, no save-someone-else's: a trail is private to whoever
         built it, and nothing here may imply otherwise. */
      expect(find.byIcon(Icons.favorite_border), findsNothing);
      expect(find.byIcon(Icons.share), findsNothing);
      expect(find.textContaining('por @'), findsNothing);
    });

    testWidgets('pages rather than loading everything (§43)', (
      WidgetTester tester,
    ) async {
      final FakeTrailsApi api = FakeTrailsApi()
        ..listResult = <TrailSummary>[summary()]
        ..nextCursor = 'cursor-1';
      final ProviderContainer container = trailTestContainer(trails: api);
      addTearDown(container.dispose);

      await tester.pumpWidget(listHost(container));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Carregar mais'));
      await tester.pumpAndSettle();

      expect(api.cursorsRequested, <String?>[null, 'cursor-1']);
    });
  });

  group('failure messages (§78)', () {
    test('never leak a status code or an exception type', () {
      for (final FailureKind kind in FailureKind.values) {
        final String message = trailFailureMessage(
          AppFailure(kind: kind, message: 'raw: 409 DioException'),
        );

        expect(message, isNot(contains('409')));
        expect(message, isNot(contains('Exception')));
      }
    });

    test('tells a conflict apart from a plain failure', () {
      const AppFailure conflict = AppFailure(
        kind: FailureKind.conflict,
        message: '',
      );
      const AppFailure network = AppFailure(
        kind: FailureKind.networkUnavailable,
        message: '',
      );

      /* The remedy differs: one is reloaded, the other retried. */
      expect(
        trailFailureMessage(conflict),
        isNot(trailFailureMessage(network)),
      );
      expect(trailFailureMessage(conflict), contains('Recarregue'));
    });
  });
}

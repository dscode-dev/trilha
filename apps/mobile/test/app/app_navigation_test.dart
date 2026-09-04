import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:trilha_mobile/app/app.dart';
import 'package:trilha_mobile/app/bootstrap/providers.dart';
import 'package:trilha_mobile/app/config/app_config.dart';
import 'package:trilha_mobile/app/config/app_environment.dart';
import 'package:trilha_mobile/app/navigation/app_router.dart';
import 'package:trilha_mobile/app/navigation/app_routes.dart';
import 'package:trilha_mobile/core/logging/app_logger.dart';
import 'package:trilha_mobile/core/networking/api_client.dart';
import 'package:trilha_mobile/core/observability/error_reporter.dart';
import 'package:trilha_mobile/features/root/presentation/root_screen.dart';

/// Builds the real composition root with the same overrides bootstrap installs.
ProviderContainer _container() {
  return ProviderContainer(
    overrides: [
      appConfigProvider.overrideWithValue(
        AppConfig.forEnvironment(AppEnvironment.development),
      ),
      appLoggerProvider.overrideWithValue(const AppLogger(name: 'test')),
      errorReporterProvider.overrideWithValue(
        const LoggingErrorReporter(AppLogger(name: 'test')),
      ),
    ],
  );
}

Widget _app(ProviderContainer container) {
  return UncontrolledProviderScope(
    container: container,
    child: const TrilhaApp(),
  );
}

void main() {
  group('Composition root', () {
    test('config, logger and reporter resolve from overrides', () {
      final ProviderContainer container = _container();
      addTearDown(container.dispose);

      expect(
        container.read(appConfigProvider).environment,
        AppEnvironment.development,
      );
      expect(container.read(appLoggerProvider).name, 'test');
      expect(
        container.read(errorReporterProvider),
        isA<LoggingErrorReporter>(),
      );
    });

    test('the API client is built from the injected configuration', () {
      final ProviderContainer container = _container();
      addTearDown(container.dispose);

      final ApiClient client = container.read(apiClientProvider);
      expect(
        client.raw.options.baseUrl,
        container.read(appConfigProvider).apiBaseUrl,
      );
    });

    test('providers without an override fail loudly rather than silently', () {
      final ProviderContainer bare = ProviderContainer();
      addTearDown(bare.dispose);

      // Riverpod 3 wraps a provider's own error in a ProviderException; what
      // matters is that the missing override surfaces loudly and explains itself.
      expect(
        () => bare.read(appConfigProvider),
        throwsA(
          predicate<Object>(
            (Object e) => e.toString().contains('must be overridden'),
            'reports the missing override',
          ),
        ),
      );
    });

    test('the API client is a singleton within a scope', () {
      final ProviderContainer container = _container();
      addTearDown(container.dispose);

      expect(
        identical(
          container.read(apiClientProvider),
          container.read(apiClientProvider),
        ),
        isTrue,
      );
    });
  });

  group('Navigation', () {
    testWidgets('boots to the root route', (WidgetTester tester) async {
      final ProviderContainer container = _container();
      addTearDown(container.dispose);

      await tester.pumpWidget(_app(container));
      await tester.pumpAndSettle();

      expect(find.byType(RootScreen), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('applies the brand theme to the running app', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = _container();
      addTearDown(container.dispose);

      await tester.pumpWidget(_app(container));
      await tester.pumpAndSettle();

      final MaterialApp app = tester.widget<MaterialApp>(
        find.byType(MaterialApp),
      );
      expect(app.theme, isNotNull);
      expect(
        app.darkTheme,
        isNotNull,
        reason: 'dark mode must be supported from day one',
      );
      expect(app.themeMode, ThemeMode.system);
    });

    testWidgets(
      'shows a real screen for an unknown deep link instead of crashing',
      (WidgetTester tester) async {
        final ProviderContainer container = _container();
        addTearDown(container.dispose);

        await tester.pumpWidget(_app(container));
        await tester.pumpAndSettle();

        container.read(appRouterProvider).go('/does-not-exist');
        await tester.pumpAndSettle();

        expect(find.byType(RouteNotFoundScreen), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('can navigate back to root from the not-found screen', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = _container();
      addTearDown(container.dispose);

      await tester.pumpWidget(_app(container));
      await tester.pumpAndSettle();

      container.read(appRouterProvider).go('/does-not-exist');
      await tester.pumpAndSettle();

      await tester.tap(find.text('Go to start'));
      await tester.pumpAndSettle();

      expect(find.byType(RootScreen), findsOneWidget);
    });

    test('the root route is registered under a stable name', () {
      expect(AppRoutes.rootName, 'root');
      expect(AppRoutes.rootPath, '/');
    });

    testWidgets('the router is disposed with its scope', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = _container();
      final GoRouter router = container.read(appRouterProvider);

      container.dispose();

      // A disposed router rejects further use rather than leaking listeners.
      expect(() => router.go('/'), throwsA(anything));
    });
  });
}

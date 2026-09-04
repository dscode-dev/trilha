import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:trilha_mobile/app/app.dart';
import 'package:trilha_mobile/app/bootstrap/providers.dart';
import 'package:trilha_mobile/app/config/app_environment.dart';
import 'package:trilha_mobile/app/navigation/app_router.dart';
import 'package:trilha_mobile/core/networking/api_client.dart';
import 'package:trilha_mobile/features/auth/application/auth_providers.dart';
import 'package:trilha_mobile/features/auth/application/auth_state.dart';
import 'package:trilha_mobile/features/auth/presentation/auth_routes.dart';
import 'package:trilha_mobile/features/map/presentation/map_screen.dart';
import 'package:trilha_mobile/features/auth/presentation/sign_in_screen.dart';
import 'package:trilha_mobile/features/auth/presentation/sign_up_screen.dart';
import 'package:trilha_mobile/features/profile/presentation/profile_screen.dart';
import 'package:trilha_mobile/features/root/presentation/root_screen.dart';

import '../support/auth_fakes.dart';
import '../support/places_fakes.dart';

/// Composition root and auth-derived navigation (§36, §51).
void main() {
  Widget app(ProviderContainer container) =>
      UncontrolledProviderScope(container: container, child: const TrilhaApp());

  group('Composition root', () {
    test('config, logger and reporter resolve from overrides', () {
      final ProviderContainer container = placesTestContainer();
      addTearDown(container.dispose);

      expect(
        container.read(appConfigProvider).environment,
        AppEnvironment.development,
      );
      expect(container.read(appLoggerProvider).name, 'test');
      expect(container.read(errorReporterProvider), isNotNull);
    });

    test('the API client is built from the injected configuration', () {
      final ProviderContainer container = placesTestContainer();
      addTearDown(container.dispose);

      final ApiClient client = container.read(apiClientProvider);
      expect(
        client.raw.options.baseUrl,
        container.read(appConfigProvider).apiBaseUrl,
      );
    });

    test('the API client carries the auth interceptor', () {
      final ProviderContainer container = placesTestContainer();
      addTearDown(container.dispose);

      // Request id, logging and auth — auth must be present or protected calls
      // would silently go out unauthenticated.
      expect(
        container.read(apiClientProvider).raw.interceptors.length,
        greaterThanOrEqualTo(3),
      );
    });

    test('providers without an override fail loudly rather than silently', () {
      final ProviderContainer bare = ProviderContainer();
      addTearDown(bare.dispose);

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
      final ProviderContainer container = placesTestContainer();
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

  group('Navigation derived from auth state (§36)', () {
    testWidgets('holds on the launch surface while bootstrapping', (
      WidgetTester tester,
    ) async {
      // A slow store keeps the bootstrapping window open long enough to observe,
      // which is what a real Keychain read does.
      final ProviderContainer container = authTestContainer(
        tokenStore: FakeTokenStore(null, const Duration(milliseconds: 200)),
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(app(container));
      await tester.pump();

      expect(container.read(authControllerProvider), isA<AuthBootstrapping>());
      expect(find.byType(RootScreen), findsOneWidget);
      expect(
        find.byType(SignInScreen),
        findsNothing,
        reason: 'must not flash sign-in',
      );

      // Let the pending read finish so the test ends with no live timer.
      await tester.pumpAndSettle();
    });

    testWidgets('lands on sign-in when no session is stored', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = placesTestContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(app(container));
      await tester.pumpAndSettle();

      expect(find.byType(SignInScreen), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'restores a stored session straight to the authenticated root',
      (WidgetTester tester) async {
        final ProviderContainer container = authTestContainer(
          tokenStore: FakeTokenStore('stored-refresh-token'),
        );
        addTearDown(container.dispose);

        await tester.pumpWidget(app(container));
        await tester.pumpAndSettle();

        expect(find.byType(MapScreen), findsOneWidget);
        expect(find.byType(SignInScreen), findsNothing);
      },
    );

    testWidgets(
      'signing in moves to the authenticated root with no manual navigation',
      (WidgetTester tester) async {
        final ProviderContainer container = placesTestContainer();
        addTearDown(container.dispose);

        await tester.pumpWidget(app(container));
        await tester.pumpAndSettle();
        expect(find.byType(SignInScreen), findsOneWidget);

        await container
            .read(authControllerProvider.notifier)
            .login(email: 'ana@trilha.test', password: 'a quiet trail');
        await tester.pumpAndSettle();

        expect(find.byType(MapScreen), findsOneWidget);
      },
    );

    testWidgets('signing out returns to sign-in', (WidgetTester tester) async {
      final ProviderContainer container = placesTestContainer(
        tokenStore: FakeTokenStore('stored-refresh-token'),
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(app(container));
      await tester.pumpAndSettle();
      expect(find.byType(MapScreen), findsOneWidget);

      await container.read(authControllerProvider.notifier).logout();
      await tester.pumpAndSettle();

      expect(find.byType(SignInScreen), findsOneWidget);
    });

    testWidgets('an unauthenticated user cannot reach a protected route', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = placesTestContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(app(container));
      await tester.pumpAndSettle();

      container.read(appRouterProvider).go(AuthRoutes.profilePath);
      await tester.pumpAndSettle();

      expect(find.byType(ProfileScreen), findsNothing);
      expect(find.byType(SignInScreen), findsOneWidget);
    });

    testWidgets('an authenticated user cannot go back to sign-in', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = placesTestContainer(
        tokenStore: FakeTokenStore('stored-refresh-token'),
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(app(container));
      await tester.pumpAndSettle();

      container.read(appRouterProvider).go(AuthRoutes.loginPath);
      await tester.pumpAndSettle();

      expect(find.byType(SignInScreen), findsNothing);
      expect(find.byType(MapScreen), findsOneWidget);
    });

    testWidgets('an authenticated user can reach the profile', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = placesTestContainer(
        tokenStore: FakeTokenStore('stored-refresh-token'),
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(app(container));
      await tester.pumpAndSettle();

      container.read(appRouterProvider).go(AuthRoutes.profilePath);
      await tester.pumpAndSettle();

      expect(find.byType(ProfileScreen), findsOneWidget);
    });

    testWidgets('registration is reachable from sign-in', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = placesTestContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(app(container));
      await tester.pumpAndSettle();

      await tester.tap(find.text('New to Trilha? Create an account'));
      await tester.pumpAndSettle();

      expect(find.byType(SignUpScreen), findsOneWidget);
    });
  });

  group('Theme and error routes', () {
    testWidgets('applies the brand theme to the running app', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = placesTestContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(app(container));
      await tester.pumpAndSettle();

      final MaterialApp materialApp = tester.widget<MaterialApp>(
        find.byType(MaterialApp),
      );
      expect(materialApp.theme, isNotNull);
      expect(
        materialApp.darkTheme,
        isNotNull,
        reason: 'dark mode from day one',
      );
      expect(materialApp.themeMode, ThemeMode.system);
    });

    test('route names are stable', () {
      expect(AuthRoutes.loginName, 'sign-in');
      /* The authenticated root became the map in PR-02: Trilha is map-first. */
      expect(AuthRoutes.homeName, 'map');
      expect(AuthRoutes.homePath, '/map');
      expect(AuthRoutes.profileName, 'profile');
    });

    testWidgets('the router is disposed with its scope', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = placesTestContainer();
      final GoRouter router = container.read(appRouterProvider);

      container.dispose();

      expect(() => router.go('/'), throwsA(anything));
    });
  });
}

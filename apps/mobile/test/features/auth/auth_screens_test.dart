import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/app/app.dart';
import 'package:trilha_mobile/app/navigation/app_router.dart';
import 'package:trilha_mobile/features/auth/domain/auth_failure.dart';
import 'package:trilha_mobile/features/auth/presentation/auth_routes.dart';
import 'package:trilha_mobile/features/auth/presentation/home_screen.dart';
import 'package:trilha_mobile/features/auth/presentation/sign_in_screen.dart';
import 'package:trilha_mobile/features/profile/presentation/profile_screen.dart';
import 'package:trilha_mobile/shared/widgets/async_action_button.dart';

import '../../support/auth_fakes.dart';

/// The auth and profile surfaces (§41, §42, §43, §46, §51).
void main() {
  Widget app(ProviderContainer container) =>
      UncontrolledProviderScope(container: container, child: const TrilhaApp());

  Future<ProviderContainer> signedIn(
    WidgetTester tester, {
    FakeAuthApi? api,
  }) async {
    final ProviderContainer container = authTestContainer(
      api: api,
      tokenStore: FakeTokenStore('stored-refresh-token'),
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(app(container));
    await tester.pumpAndSettle();
    return container;
  }

  group('Sign-in screen (§41)', () {
    testWidgets('validates locally before calling the API', (
      WidgetTester tester,
    ) async {
      final FakeAuthApi api = FakeAuthApi();
      final ProviderContainer container = authTestContainer(api: api);
      addTearDown(container.dispose);

      await tester.pumpWidget(app(container));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pumpAndSettle();

      expect(find.text('Enter your email'), findsOneWidget);
      expect(find.text('Enter your password'), findsOneWidget);
      expect(api.loginCalls, 0, reason: 'no round trip for an empty form');
    });

    testWidgets('rejects a malformed email without a round trip', (
      WidgetTester tester,
    ) async {
      final FakeAuthApi api = FakeAuthApi();
      final ProviderContainer container = authTestContainer(api: api);
      addTearDown(container.dispose);

      await tester.pumpWidget(app(container));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Email'),
        'not-an-email',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Password'),
        'whatever',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pumpAndSettle();

      expect(find.text('Enter a valid email address'), findsOneWidget);
      expect(api.loginCalls, 0);
    });

    testWidgets('shows a human message for invalid credentials (§45)', (
      WidgetTester tester,
    ) async {
      final FakeAuthApi api = FakeAuthApi()
        ..loginFailure = const AuthFailure(
          kind: AuthFailureKind.invalidCredentials,
          message: 'Email or password is incorrect',
        );
      final ProviderContainer container = authTestContainer(api: api);
      addTearDown(container.dispose);

      await tester.pumpWidget(app(container));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Email'),
        'ana@trilha.test',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Password'),
        'wrong-password',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pumpAndSettle();

      expect(find.text('Email or password is incorrect.'), findsOneWidget);
      // Never a status code or an exception type.
      expect(find.textContaining('401'), findsNothing);
      expect(find.textContaining('Exception'), findsNothing);
    });

    testWidgets('distinguishes offline from wrong credentials (§47)', (
      WidgetTester tester,
    ) async {
      final FakeAuthApi api = FakeAuthApi()
        ..loginFailure = const AuthFailure(
          kind: AuthFailureKind.networkUnavailable,
          message: 'Offline',
        );
      final ProviderContainer container = authTestContainer(api: api);
      addTearDown(container.dispose);

      await tester.pumpWidget(app(container));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Email'),
        'ana@trilha.test',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Password'),
        'a quiet trail',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pumpAndSettle();

      expect(find.textContaining('No connection'), findsOneWidget);
    });

    testWidgets('reports a throttled attempt with the wait (§26)', (
      WidgetTester tester,
    ) async {
      final FakeAuthApi api = FakeAuthApi()
        ..loginFailure = const AuthFailure(
          kind: AuthFailureKind.rateLimited,
          message: 'Too many attempts',
          retryAfterSeconds: 120,
        );
      final ProviderContainer container = authTestContainer(api: api);
      addTearDown(container.dispose);

      await tester.pumpWidget(app(container));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Email'),
        'ana@trilha.test',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Password'),
        'a quiet trail',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Too many attempts'), findsOneWidget);
      expect(find.textContaining('2 minutes'), findsOneWidget);
    });

    testWidgets('repeated taps cannot start two sign-ins (§46)', (
      WidgetTester tester,
    ) async {
      // A real request takes time, and that window is exactly what the guard
      // protects; an instant fake would make it zero frames wide.
      final FakeAuthApi api = FakeAuthApi()
        ..latency = const Duration(milliseconds: 120);
      final ProviderContainer container = authTestContainer(api: api);
      addTearDown(container.dispose);

      await tester.pumpWidget(app(container));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Email'),
        'ana@trilha.test',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Password'),
        'a quiet trail',
      );

      final Finder button = find.byType(AsyncActionButton);
      await tester.tap(button);
      await tester.pump();
      // Second and third taps land while the first is still in flight.
      await tester.tap(button, warnIfMissed: false);
      await tester.tap(button, warnIfMissed: false);
      await tester.pumpAndSettle();

      expect(api.loginCalls, 1);
    });

    testWidgets('never renders the password', (WidgetTester tester) async {
      final ProviderContainer container = authTestContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(app(container));
      await tester.pumpAndSettle();

      final TextField password = tester.widget<TextField>(
        find.descendant(
          of: find.widgetWithText(TextFormField, 'Password'),
          matching: find.byType(TextField),
        ),
      );
      expect(password.obscureText, isTrue);
    });
  });

  group('Sign-up screen (§42)', () {
    Future<void> openSignUp(
      WidgetTester tester,
      ProviderContainer container,
    ) async {
      await tester.pumpWidget(app(container));
      await tester.pumpAndSettle();
      container.read(appRouterProvider).go(AuthRoutes.registerPath);
      await tester.pumpAndSettle();
    }

    testWidgets('validates every field locally', (WidgetTester tester) async {
      final FakeAuthApi api = FakeAuthApi();
      final ProviderContainer container = authTestContainer(api: api);
      addTearDown(container.dispose);

      await openSignUp(tester, container);
      await tester.tap(find.widgetWithText(FilledButton, 'Create account'));
      await tester.pumpAndSettle();

      expect(find.text('Enter your name'), findsOneWidget);
      expect(find.text('Choose a username'), findsOneWidget);
      expect(find.text('Enter your email'), findsOneWidget);
      expect(api.registerCalls, 0);
    });

    testWidgets('enforces the password minimum before submitting', (
      WidgetTester tester,
    ) async {
      final FakeAuthApi api = FakeAuthApi();
      final ProviderContainer container = authTestContainer(api: api);
      addTearDown(container.dispose);

      await openSignUp(tester, container);

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Name'),
        'Ana Souza',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Username'),
        'ana-souza',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Email'),
        'ana@trilha.test',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Password'),
        'short',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Create account'));
      await tester.pumpAndSettle();

      expect(find.textContaining('at least 12 characters'), findsOneWidget);
      expect(api.registerCalls, 0);
    });

    testWidgets('surfaces a server-side email conflict on the field', (
      WidgetTester tester,
    ) async {
      final FakeAuthApi api = FakeAuthApi()
        ..registerFailure = const AuthFailure(
          kind: AuthFailureKind.emailAlreadyInUse,
          message: 'That email address is already registered',
        );
      final ProviderContainer container = authTestContainer(api: api);
      addTearDown(container.dispose);

      await openSignUp(tester, container);

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Name'),
        'Ana Souza',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Username'),
        'ana-souza',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Email'),
        'taken@trilha.test',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Password'),
        'a quiet trail through pine',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Create account'));
      await tester.pumpAndSettle();

      // Availability is never guessed at locally — the server's answer is shown.
      expect(find.text('That email is already registered'), findsOneWidget);
      expect(api.registerCalls, 1);
    });

    testWidgets('a successful registration lands on the authenticated root', (
      WidgetTester tester,
    ) async {
      final FakeAuthApi api = FakeAuthApi();
      final ProviderContainer container = authTestContainer(api: api);
      addTearDown(container.dispose);

      await openSignUp(tester, container);

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Name'),
        'Ana Souza',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Username'),
        'ana-souza',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Email'),
        'ana@trilha.test',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Password'),
        'a quiet trail through pine',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Create account'));
      await tester.pumpAndSettle();

      expect(find.byType(HomeScreen), findsOneWidget);
    });
  });

  group('Authenticated root (§44)', () {
    testWidgets('greets the signed-in user and shows no fabricated content', (
      WidgetTester tester,
    ) async {
      await signedIn(tester);

      expect(find.textContaining('Hello, Ana Souza'), findsOneWidget);

      // PR-01 ships no product surface; anything resembling one would be a lie.
      for (final String forbidden in <String>[
        'Trails',
        'Nearby',
        'Explore',
        'Feed',
        'km',
        'Followers',
        'Badges',
        'Reviews',
      ]) {
        expect(
          find.textContaining(forbidden),
          findsNothing,
          reason: 'found "$forbidden"',
        );
      }
    });
  });

  group('Profile screen (§43)', () {
    Future<ProviderContainer> openProfile(
      WidgetTester tester, {
      FakeAuthApi? api,
    }) async {
      final ProviderContainer container = await signedIn(tester, api: api);
      container.read(appRouterProvider).go(AuthRoutes.profilePath);
      await tester.pumpAndSettle();
      return container;
    }

    testWidgets('shows the account with an initials avatar, not a fake photo', (
      WidgetTester tester,
    ) async {
      await openProfile(tester);

      expect(find.byType(ProfileScreen), findsOneWidget);
      expect(find.text('ana@trilha.test'), findsOneWidget);
      expect(
        find.text('AS'),
        findsOneWidget,
        reason: 'initials derived from the name',
      );
    });

    testWidgets('saves an edited display name', (WidgetTester tester) async {
      final FakeAuthApi api = FakeAuthApi();
      await openProfile(tester, api: api);

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Name'),
        'Ana Renamed',
      );
      await tester.ensureVisible(find.byType(AsyncActionButton));
      await tester.tap(find.byType(AsyncActionButton));
      await tester.pumpAndSettle();

      expect(api.updateProfileCalls, 1);
      expect(find.text('Profile updated'), findsOneWidget);
    });

    testWidgets('repeated save taps cannot start two updates (§46)', (
      WidgetTester tester,
    ) async {
      final FakeAuthApi api = FakeAuthApi()
        ..latency = const Duration(milliseconds: 120);
      await openProfile(tester, api: api);

      final Finder save = find.byType(AsyncActionButton);
      await tester.ensureVisible(save);
      await tester.tap(save);
      await tester.pump();
      await tester.tap(save, warnIfMissed: false);
      await tester.pumpAndSettle();

      expect(api.updateProfileCalls, 1);
    });

    testWidgets('offers sign out and sign out everywhere', (
      WidgetTester tester,
    ) async {
      await openProfile(tester);

      expect(find.text('Sign out'), findsOneWidget);
      expect(find.text('Sign out everywhere'), findsOneWidget);
      expect(find.text('Change password'), findsOneWidget);
    });

    testWidgets('signing out returns to sign-in', (WidgetTester tester) async {
      final FakeAuthApi api = FakeAuthApi();
      await openProfile(tester, api: api);

      await tester.ensureVisible(find.text('Sign out'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Sign out'));
      await tester.pumpAndSettle();

      expect(api.logoutCalls, 1);
      expect(find.byType(SignInScreen), findsOneWidget);
    });

    testWidgets('sign out everywhere asks for confirmation first', (
      WidgetTester tester,
    ) async {
      final FakeAuthApi api = FakeAuthApi();
      await openProfile(tester, api: api);

      await tester.ensureVisible(find.text('Sign out everywhere'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Sign out everywhere'));
      await tester.pumpAndSettle();

      expect(find.text('Sign out everywhere?'), findsOneWidget);
      expect(api.logoutAllCalls, 0, reason: 'not until confirmed');

      await tester.tap(
        find.widgetWithText(FilledButton, 'Sign out everywhere'),
      );
      await tester.pumpAndSettle();

      expect(api.logoutAllCalls, 1);
      expect(find.byType(SignInScreen), findsOneWidget);
    });

    testWidgets('cancelling the confirmation keeps the session', (
      WidgetTester tester,
    ) async {
      final FakeAuthApi api = FakeAuthApi();
      await openProfile(tester, api: api);

      await tester.ensureVisible(find.text('Sign out everywhere'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Sign out everywhere'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();

      expect(api.logoutAllCalls, 0);
      expect(find.byType(ProfileScreen), findsOneWidget);
    });

    testWidgets('shows no statistics, badges or followers', (
      WidgetTester tester,
    ) async {
      await openProfile(tester);

      for (final String forbidden in <String>[
        'Followers',
        'Badges',
        'Level',
        'Trails',
        'Points',
      ]) {
        expect(
          find.textContaining(forbidden),
          findsNothing,
          reason: 'found "$forbidden"',
        );
      }
    });
  });

  group('Change password (§24)', () {
    testWidgets('warns that every session will end, then signs out', (
      WidgetTester tester,
    ) async {
      final FakeAuthApi api = FakeAuthApi();
      final ProviderContainer container = await signedIn(tester, api: api);

      container.read(appRouterProvider).go(AuthRoutes.changePasswordPath);
      await tester.pumpAndSettle();

      expect(
        find.textContaining('signs you out on every device'),
        findsOneWidget,
      );

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Current password'),
        'a quiet trail',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'New password'),
        'an entirely different phrase',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Confirm new password'),
        'an entirely different phrase',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Change password'));
      await tester.pumpAndSettle();

      expect(api.changePasswordCalls, 1);
      expect(find.byType(SignInScreen), findsOneWidget);
    });

    testWidgets('requires the confirmation to match', (
      WidgetTester tester,
    ) async {
      final FakeAuthApi api = FakeAuthApi();
      final ProviderContainer container = await signedIn(tester, api: api);

      container.read(appRouterProvider).go(AuthRoutes.changePasswordPath);
      await tester.pumpAndSettle();

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Current password'),
        'a quiet trail',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'New password'),
        'an entirely different phrase',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Confirm new password'),
        'something else entirely',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Change password'));
      await tester.pumpAndSettle();

      expect(find.text('Passwords do not match'), findsOneWidget);
      expect(api.changePasswordCalls, 0);
    });
  });
}

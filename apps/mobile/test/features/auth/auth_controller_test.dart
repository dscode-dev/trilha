import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/features/auth/application/auth_controller.dart';
import 'package:trilha_mobile/features/auth/application/auth_providers.dart';
import 'package:trilha_mobile/features/auth/application/auth_state.dart';
import 'package:trilha_mobile/features/auth/domain/auth_failure.dart';

import '../../support/auth_fakes.dart';

/// Session lifecycle on the client (§36, §38, §39, §40, §51).
void main() {
  late FakeAuthApi api;
  late FakeTokenStore store;
  ProviderContainer? active;

  /// Builds the container on first use, so a test can configure [store] and [api]
  /// before the controller's `build()` kicks off `restore()`.
  ProviderContainer container() =>
      active ??= authTestContainer(api: api, tokenStore: store);

  AuthController controller() =>
      container().read(authControllerProvider.notifier);
  AuthState state() => container().read(authControllerProvider);

  /// Drains pending microtasks and timers so the `restore()` started by `build()`
  /// has genuinely finished — a fixed microtask count would race a delayed refresh.
  Future<void> settle() async {
    for (int i = 0; i < 5; i += 1) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
  }

  setUp(() {
    api = FakeAuthApi();
    store = FakeTokenStore();
    active = null;
  });

  tearDown(() {
    active?.dispose();
    active = null;
  });

  group('bootstrap (§36)', () {
    test('starts in the bootstrapping state', () {
      expect(state(), isA<AuthBootstrapping>());
    });

    test('settles to unauthenticated when no token is stored', () async {
      controller();
      await settle();

      expect(state(), isA<AuthUnauthenticated>());
      expect(store.readCount, 1);
      expect(api.refreshCalls, 0, reason: 'nothing to refresh');
    });

    test('restores a session from a stored refresh token (§73)', () async {
      store = FakeTokenStore('stored-refresh-token');

      controller();
      await settle();

      expect(state(), isA<AuthAuthenticated>());
      expect(api.refreshCalls, 1);
      expect(api.refreshTokensSeen.single, 'stored-refresh-token');
      expect(
        state().accountOrNull?.username,
        FakeAuthApi.defaultAccount.username,
      );
    });

    test('rotates the stored token, persisting the replacement', () async {
      store = FakeTokenStore('stored-refresh-token');

      controller();
      await settle();

      expect(store.storedToken, isNot('stored-refresh-token'));
      expect(store.writeCount, greaterThan(0));
    });

    test('clears a rejected session and signs the user out (§40)', () async {
      store = FakeTokenStore('revoked-token');
      api.refreshFailure = const AuthFailure(
        kind: AuthFailureKind.sessionExpired,
        message: 'Session ended',
      );

      controller();
      await settle();

      expect(state(), isA<AuthUnauthenticated>());
      expect(
        store.storedToken,
        isNull,
        reason: 'a dead token must not be kept',
      );
      expect(
        api.refreshCalls,
        1,
        reason: 'a terminal failure is never retried',
      );
    });

    test('keeps the stored token when the network is down (§47)', () async {
      store = FakeTokenStore('good-token');
      api.refreshFailure = const AuthFailure(
        kind: AuthFailureKind.networkUnavailable,
        message: 'Offline',
      );

      controller();
      await settle();

      // Being offline is not being signed out: the next launch must be able to
      // recover without asking for credentials again.
      expect(state(), isA<AuthUnauthenticated>());
      expect(store.storedToken, 'good-token');
    });
  });

  group('sign in and out', () {
    test('login stores the refresh token and loads the account', () async {
      controller();
      await settle();

      await controller().login(
        email: 'ana@trilha.test',
        password: 'a quiet trail',
      );

      expect(state(), isA<AuthAuthenticated>());
      expect(api.loginCalls, 1);
      expect(store.storedToken, isNotNull);
    });

    test('register signs in through the same path as login', () async {
      controller();
      await settle();

      await controller().register(
        email: 'new@trilha.test',
        password: 'a quiet trail through pine',
        username: 'newby',
        displayName: 'New Body',
      );

      expect(state(), isA<AuthAuthenticated>());
      expect(state().accountOrNull?.username, 'newby');
      expect(store.storedToken, isNotNull);
    });

    test(
      'a failed login leaves the user unauthenticated with nothing stored',
      () async {
        api.loginFailure = const AuthFailure(
          kind: AuthFailureKind.invalidCredentials,
          message: 'Email or password is incorrect',
        );
        controller();
        await settle();

        await expectLater(
          controller().login(email: 'ana@trilha.test', password: 'wrong'),
          throwsA(isA<AuthFailure>()),
        );

        expect(state(), isA<AuthUnauthenticated>());
        expect(store.storedToken, isNull);
      },
    );

    test('logout clears local state and tells the server', () async {
      controller();
      await settle();
      await controller().login(
        email: 'ana@trilha.test',
        password: 'a quiet trail',
      );

      await controller().logout();

      expect(state(), isA<AuthUnauthenticated>());
      expect(store.storedToken, isNull);
      expect(api.logoutCalls, 1);
    });

    test('logout clears local state even when the server call fails', () async {
      controller();
      await settle();
      await controller().login(
        email: 'ana@trilha.test',
        password: 'a quiet trail',
      );

      // A user who taps sign-out ends up signed out regardless of connectivity.
      api.refreshFailure = const AuthFailure(
        kind: AuthFailureKind.networkUnavailable,
        message: 'Offline',
      );

      await controller().logout();

      expect(state(), isA<AuthUnauthenticated>());
      expect(store.storedToken, isNull);
    });

    test('logout-all clears local state', () async {
      controller();
      await settle();
      await controller().login(
        email: 'ana@trilha.test',
        password: 'a quiet trail',
      );

      await controller().logoutEverywhere();

      expect(api.logoutAllCalls, 1);
      expect(state(), isA<AuthUnauthenticated>());
      expect(store.storedToken, isNull);
    });
  });

  group('single-flight refresh (§39)', () {
    test('ten concurrent callers produce exactly one refresh', () async {
      store = FakeTokenStore('stored-refresh-token');

      controller();
      await settle();
      final int afterRestore = api.refreshCalls;

      // Slow the rotation only now, so the ten callers genuinely overlap.
      api.refreshDelay = const Duration(milliseconds: 40);

      // Every caller sees an expiring token, so each would refresh on its own were
      // the rotation not shared.
      final List<Future<String?>> waiters = List<Future<String?>>.generate(
        10,
        (_) => controller().forceRefresh(),
      );
      final List<String?> tokens = await Future.wait(waiters);

      expect(
        api.refreshCalls - afterRestore,
        1,
        reason: 'one rotation, not ten',
      );
      expect(
        tokens.whereType<String>().toSet().length,
        1,
        reason: 'all share one token',
      );
    });

    test(
      'a later refresh starts a new flight rather than reusing the old one',
      () async {
        store = FakeTokenStore('stored-refresh-token');

        controller();
        await settle();
        final int afterRestore = api.refreshCalls;

        await controller().forceRefresh();
        await controller().forceRefresh();

        expect(api.refreshCalls - afterRestore, 2);
      },
    );

    test('never sends the same refresh token twice', () async {
      store = FakeTokenStore('stored-refresh-token');

      controller();
      await settle();
      api.refreshDelay = const Duration(milliseconds: 20);

      await Future.wait(
        List<Future<String?>>.generate(8, (_) => controller().forceRefresh()),
      );
      await controller().forceRefresh();

      // Replaying a rotated token is what the server treats as compromise, so the
      // client must never do it.
      expect(
        api.refreshTokensSeen.toSet().length,
        api.refreshTokensSeen.length,
        reason: 'each rotation must present a distinct token',
      );
    });

    test(
      'concurrent callers all fail together when the session is dead (§40)',
      () async {
        store = FakeTokenStore('good-token');

        controller();
        await settle();
        expect(
          state(),
          isA<AuthAuthenticated>(),
          reason: 'precondition: signed in',
        );

        // The session dies server-side; every waiting caller must learn that.
        api
          ..refreshDelay = const Duration(milliseconds: 20)
          ..refreshFailure = const AuthFailure(
            kind: AuthFailureKind.sessionExpired,
            message: 'Session ended',
          );

        final List<String?> results = await Future.wait(
          List<Future<String?>>.generate(5, (_) => controller().forceRefresh()),
        );

        expect(results.every((String? token) => token == null), isTrue);
        expect(state(), isA<AuthUnauthenticated>());
        expect(store.storedToken, isNull);
      },
    );
  });

  group('profile and password', () {
    test('updateProfile replaces the account in state', () async {
      controller();
      await settle();
      await controller().login(
        email: 'ana@trilha.test',
        password: 'a quiet trail',
      );

      await controller().updateProfile(displayName: 'Ana Renamed');

      expect(state().accountOrNull?.displayName, 'Ana Renamed');
      expect(api.updateProfileCalls, 1);
    });

    test('a username conflict surfaces and leaves state untouched', () async {
      controller();
      await settle();
      await controller().login(
        email: 'ana@trilha.test',
        password: 'a quiet trail',
      );
      final String before = state().accountOrNull!.username;

      api.updateProfileFailure = const AuthFailure(
        kind: AuthFailureKind.usernameAlreadyInUse,
        message: 'That username is taken',
      );

      await expectLater(
        controller().updateProfile(username: 'taken'),
        throwsA(
          isA<AuthFailure>().having(
            (AuthFailure f) => f.kind,
            'kind',
            AuthFailureKind.usernameAlreadyInUse,
          ),
        ),
      );

      expect(state().accountOrNull?.username, before);
    });

    test('changing the password signs the session out (§24)', () async {
      controller();
      await settle();
      await controller().login(
        email: 'ana@trilha.test',
        password: 'a quiet trail',
      );

      await controller().changePassword(
        currentPassword: 'a quiet trail',
        newPassword: 'an entirely different phrase',
      );

      // The server revoked every session, this one included.
      expect(state(), isA<AuthUnauthenticated>());
      expect(store.storedToken, isNull);
      expect(api.changePasswordCalls, 1);
    });

    test('a wrong current password keeps the session alive', () async {
      controller();
      await settle();
      await controller().login(
        email: 'ana@trilha.test',
        password: 'a quiet trail',
      );

      api.changePasswordFailure = const AuthFailure(
        kind: AuthFailureKind.invalidCredentials,
        message: 'Email or password is incorrect',
      );

      await expectLater(
        controller().changePassword(
          currentPassword: 'wrong',
          newPassword: 'a new phrase here',
        ),
        throwsA(isA<AuthFailure>()),
      );

      expect(state(), isA<AuthAuthenticated>());
      expect(store.storedToken, isNotNull);
    });
  });
}

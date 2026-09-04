import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:trilha_mobile/app/bootstrap/providers.dart';
import 'package:trilha_mobile/app/config/app_config.dart';
import 'package:trilha_mobile/app/config/app_environment.dart';
import 'package:trilha_mobile/core/logging/app_logger.dart';
import 'package:trilha_mobile/core/observability/error_reporter.dart';
import 'package:trilha_mobile/features/auth/application/auth_providers.dart';
import 'package:trilha_mobile/features/auth/data/auth_api.dart';
import 'package:trilha_mobile/features/auth/data/secure_token_store.dart';
import 'package:trilha_mobile/features/auth/domain/account.dart';
import 'package:trilha_mobile/features/auth/domain/auth_failure.dart';
import 'package:trilha_mobile/features/auth/domain/auth_session.dart';

/// In-memory stand-in for platform secure storage.
///
/// Keychain and Keystore are unavailable in a test binding, so the store is faked —
/// its *contract* is what the tests assert, and a separate test verifies that the
/// production implementation targets the right platform APIs.
class FakeTokenStore implements TokenStore {
  FakeTokenStore([this._token, this.readDelay = Duration.zero]);

  String? _token;

  /// Keychain and Keystore reads are not instantaneous; a test that needs to observe
  /// the bootstrapping window sets this.
  final Duration readDelay;

  int readCount = 0;
  int writeCount = 0;
  int clearCount = 0;

  String? get storedToken => _token;

  @override
  Future<String?> readRefreshToken() async {
    readCount += 1;
    if (readDelay > Duration.zero) await Future<void>.delayed(readDelay);
    return _token;
  }

  @override
  Future<void> writeRefreshToken(String token) async {
    writeCount += 1;
    _token = token;
  }

  @override
  Future<void> clear() async {
    clearCount += 1;
    _token = null;
  }
}

/// Scriptable stand-in for the HTTP boundary (§51).
///
/// Records every call so tests can assert *how many* requests happened — which is
/// the whole point of the single-flight refresh test.
class FakeAuthApi implements AuthEndpoints {
  FakeAuthApi({Account? account}) : account = account ?? defaultAccount;

  static const Account defaultAccount = Account(
    id: '01a06cc8-9b3a-7ba0-879e-f01610559f9c',
    email: 'ana@trilha.test',
    username: 'ana',
    displayName: 'Ana Souza',
  );

  Account account;

  /// Set to make the next matching call fail.
  AuthFailure? registerFailure;
  AuthFailure? loginFailure;
  AuthFailure? refreshFailure;
  AuthFailure? meFailure;
  AuthFailure? updateProfileFailure;
  AuthFailure? changePasswordFailure;

  /// Delay applied to `refresh`, so concurrent callers genuinely overlap.
  Duration refreshDelay = Duration.zero;

  /// Delay applied to the request-response calls. A test that needs to observe a
  /// button's busy window sets this — with an instant fake the window is zero
  /// frames wide and a duplicate-submission guard cannot be seen working.
  Duration latency = Duration.zero;

  int registerCalls = 0;
  int loginCalls = 0;
  int refreshCalls = 0;
  int logoutCalls = 0;
  int logoutAllCalls = 0;
  int meCalls = 0;
  int updateProfileCalls = 0;
  int changePasswordCalls = 0;

  final List<String> refreshTokensSeen = <String>[];

  /// Incremented per issued session so successive tokens are distinguishable.
  int _issued = 0;

  Future<void> _pause() async {
    if (latency > Duration.zero) await Future<void>.delayed(latency);
  }

  AuthSession _newSession({Duration ttl = const Duration(minutes: 10)}) {
    _issued += 1;
    return AuthSession(
      accessToken: 'access-$_issued',
      refreshToken: 'refresh-$_issued',
      expiresAt: DateTime.now().toUtc().add(ttl),
    );
  }

  @override
  Future<AuthSession> register({
    required String email,
    required String password,
    required String username,
    required String displayName,
  }) async {
    registerCalls += 1;
    await _pause();
    final AuthFailure? failure = registerFailure;
    if (failure != null) throw failure;

    account = Account(
      id: account.id,
      email: email,
      username: username,
      displayName: displayName,
    );
    return _newSession();
  }

  @override
  Future<AuthSession> login({
    required String email,
    required String password,
  }) async {
    loginCalls += 1;
    await _pause();
    final AuthFailure? failure = loginFailure;
    if (failure != null) throw failure;
    return _newSession();
  }

  @override
  Future<AuthSession> refresh(String refreshToken) async {
    refreshCalls += 1;
    refreshTokensSeen.add(refreshToken);
    if (refreshDelay > Duration.zero) await Future<void>.delayed(refreshDelay);

    final AuthFailure? failure = refreshFailure;
    if (failure != null) throw failure;
    return _newSession();
  }

  @override
  Future<void> logout(String accessToken) async {
    logoutCalls += 1;
  }

  @override
  Future<void> logoutAll(String accessToken) async {
    logoutAllCalls += 1;
  }

  @override
  Future<Account> me(String accessToken) async {
    meCalls += 1;
    final AuthFailure? failure = meFailure;
    if (failure != null) throw failure;
    return account;
  }

  @override
  Future<Account> updateProfile(
    String accessToken, {
    String? username,
    String? displayName,
    Object? bio = AuthApi.unsetBio,
  }) async {
    updateProfileCalls += 1;
    await _pause();
    final AuthFailure? failure = updateProfileFailure;
    if (failure != null) throw failure;

    account = Account(
      id: account.id,
      email: account.email,
      username: username ?? account.username,
      displayName: displayName ?? account.displayName,
      bio: identical(bio, AuthApi.unsetBio) ? account.bio : bio as String?,
    );
    return account;
  }

  @override
  Future<void> changePassword(
    String accessToken, {
    required String currentPassword,
    required String newPassword,
  }) async {
    changePasswordCalls += 1;
    final AuthFailure? failure = changePasswordFailure;
    if (failure != null) throw failure;
  }
}

/// A container wired to fakes, matching what `bootstrap` installs in production.
ProviderContainer authTestContainer({
  FakeAuthApi? api,
  FakeTokenStore? tokenStore,
}) {
  return ProviderContainer(
    overrides: [
      appConfigProvider.overrideWithValue(
        AppConfig.forEnvironment(AppEnvironment.development),
      ),
      appLoggerProvider.overrideWithValue(const AppLogger(name: 'test')),
      errorReporterProvider.overrideWithValue(
        const LoggingErrorReporter(AppLogger(name: 'test')),
      ),
      authApiProvider.overrideWithValue(api ?? FakeAuthApi()),
      tokenStoreProvider.overrideWithValue(tokenStore ?? FakeTokenStore()),
    ],
  );
}

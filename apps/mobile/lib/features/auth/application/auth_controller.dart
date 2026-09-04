import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/logging/app_logger.dart';
import '../data/auth_api.dart';
import '../data/secure_token_store.dart';
import '../domain/account.dart';
import '../domain/auth_failure.dart';
import '../domain/auth_session.dart';
import '../../../app/bootstrap/providers.dart';
import 'auth_providers.dart';
import 'auth_state.dart';

/// Owns the session for the lifetime of the app (§36, §38, §39, §40).
///
/// Riverpod supplies composition and lifecycle here; the rules themselves are plain
/// Dart on this class, so they are testable without a widget tree (ADR-0005).
class AuthController extends Notifier<AuthState> {
  /// Collaborators are read through `ref` rather than injected via a constructor,
  /// which is what lets a test override [authApiProvider] or [tokenStoreProvider]
  /// and get a controller wired to fakes without touching platform storage.
  AuthEndpoints get api => ref.read(authApiProvider);
  TokenStore get tokenStore => ref.read(tokenStoreProvider);
  AppLogger get logger => ref.read(appLoggerProvider);

  /// The access token lives only in memory (§37) — never written to storage.
  AuthSession? _session;

  /// The in-flight refresh, if one is running.
  ///
  /// This single field is what makes refresh single-flight (§39): concurrent callers
  /// await the same future instead of each starting their own rotation. That matters
  /// beyond efficiency — the server rotates single-use tokens and treats a replay as
  /// compromise, so a second concurrent refresh would revoke the user's own session.
  Future<AuthSession>? _refreshInFlight;

  @override
  AuthState build() {
    unawaited(restore());
    return const AuthBootstrapping();
  }

  /// Current access token, refreshing first if it is expiring (§38).
  ///
  /// Returns null when there is no usable session; the caller should treat that as
  /// unauthenticated rather than retrying.
  Future<String?> currentAccessToken() async {
    final AuthSession? session = _session;
    if (session == null) return null;
    if (!session.isExpiring()) return session.accessToken;

    try {
      return (await _refreshSession(session.refreshToken)).accessToken;
    } on AuthFailure {
      return null;
    }
  }

  /// Recovers from a rejected access token (§38, §39).
  ///
  /// [staleToken] is the token the failed request actually sent. If the session now
  /// holds a *different* access token, another caller has already rotated and this
  /// one simply takes the result — no second rotation.
  ///
  /// That check is what keeps a burst of 401s to one rotation. In-flight callers are
  /// collapsed by [_refreshSession]; callers that arrive just *after* a rotation
  /// completes are collapsed here. Without it, ten queued 401s would rotate ten
  /// times: not a reuse violation, but ten needless round trips and ten discarded
  /// refresh tokens.
  ///
  /// Returns null when the session is genuinely gone; the caller must not retry.
  Future<String?> forceRefresh({String? staleToken}) async {
    final AuthSession? session = _session;
    if (session == null) return null;

    if (staleToken != null && session.accessToken != staleToken) {
      return session.accessToken;
    }

    try {
      return (await _refreshSession(session.refreshToken)).accessToken;
    } on AuthFailure {
      return null;
    }
  }

  /// Restores a session from secure storage at launch (§73).
  Future<void> restore() async {
    final String? refreshToken = await tokenStore.readRefreshToken();
    // The scope can be torn down while storage is being read; continuing would
    // touch a disposed Ref.
    if (!ref.mounted) return;

    if (refreshToken == null) {
      state = const AuthUnauthenticated();
      return;
    }

    try {
      final AuthSession session = await _refreshSession(refreshToken);
      if (!ref.mounted) return;
      await _loadAccount(session);
    } on AuthFailure catch (failure) {
      if (!ref.mounted) return;
      // A network problem is not a signed-out user: keeping the stored token lets
      // the next launch succeed once connectivity returns (§47).
      if (failure.kind == AuthFailureKind.networkUnavailable) {
        state = AuthUnauthenticated(reason: failure);
        return;
      }
      await _clearSession(reason: failure);
    }
  }

  Future<void> register({
    required String email,
    required String password,
    required String username,
    required String displayName,
  }) async {
    final AuthSession session = await api.register(
      email: email,
      password: password,
      username: username,
      displayName: displayName,
    );
    await _persist(session);
    await _loadAccount(session);
  }

  Future<void> login({required String email, required String password}) async {
    final AuthSession session = await api.login(
      email: email,
      password: password,
    );
    await _persist(session);
    await _loadAccount(session);
  }

  Future<void> logout() async {
    final AuthSession? session = _session;
    if (session != null) {
      try {
        await api.logout(session.accessToken);
      } on AuthFailure catch (failure) {
        // The local session is cleared regardless: a user who taps sign-out must end
        // up signed out even if the network call fails.
        logger.warning(
          'Server logout failed; clearing local session',
          context: {'kind': failure.kind.name},
        );
      }
    }
    await _clearSession();
  }

  Future<void> logoutEverywhere() async {
    final AuthSession? session = _session;
    if (session != null) {
      try {
        await api.logoutAll(session.accessToken);
      } on AuthFailure catch (failure) {
        logger.warning(
          'Server logout-all failed; clearing local session',
          context: {'kind': failure.kind.name},
        );
      }
    }
    await _clearSession();
  }

  /// `bio` is tri-state: omit it to leave the value alone, pass null to clear it.
  Future<void> updateProfile({
    String? username,
    String? displayName,
    Object? bio = AuthApi.unsetBio,
  }) async {
    final String? accessToken = await currentAccessToken();
    if (accessToken == null) {
      await _clearSession(reason: _expired);
      throw _expired;
    }

    final Account account = await api.updateProfile(
      accessToken,
      username: username,
      displayName: displayName,
      bio: bio,
    );
    state = AuthAuthenticated(account);
  }

  /// Changes the password. The server revokes every session, including this one, so
  /// the local session is cleared and the app returns to the sign-in screen (§24).
  Future<void> changePassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    final String? accessToken = await currentAccessToken();
    if (accessToken == null) {
      await _clearSession(reason: _expired);
      throw _expired;
    }

    await api.changePassword(
      accessToken,
      currentPassword: currentPassword,
      newPassword: newPassword,
    );
    await _clearSession();
  }

  /// Rotates the session, collapsing concurrent callers onto one request (§39).
  Future<AuthSession> _refreshSession(String refreshToken) {
    final Future<AuthSession>? inFlight = _refreshInFlight;
    if (inFlight != null) return inFlight;

    final Future<AuthSession> attempt = _performRefresh(refreshToken);
    _refreshInFlight = attempt;

    // Cleared in a `whenComplete` so the next refresh starts fresh whether this one
    // succeeded or failed — leaving a settled future here would pin a dead session.
    return attempt.whenComplete(() {
      _refreshInFlight = null;
    });
  }

  Future<AuthSession> _performRefresh(String refreshToken) async {
    try {
      final AuthSession session = await api.refresh(refreshToken);
      await _persist(session);
      return session;
    } on AuthFailure catch (failure) {
      // A revoked or replayed session is terminal — never retried (§40).
      if (failure.kind != AuthFailureKind.networkUnavailable) {
        await _clearSession(reason: failure);
      }
      rethrow;
    }
  }

  Future<void> _loadAccount(AuthSession session) async {
    try {
      final Account account = await api.me(session.accessToken);
      if (!ref.mounted) return;
      state = AuthAuthenticated(account);
    } on AuthFailure catch (failure) {
      await _clearSession(reason: failure);
    }
  }

  Future<void> _persist(AuthSession session) async {
    _session = session;
    if (!ref.mounted) return;
    await tokenStore.writeRefreshToken(session.refreshToken);
  }

  Future<void> _clearSession({AuthFailure? reason}) async {
    _session = null;
    _refreshInFlight = null;
    if (!ref.mounted) return;
    await tokenStore.clear();
    if (!ref.mounted) return;
    state = AuthUnauthenticated(reason: reason);
  }

  static const AuthFailure _expired = AuthFailure(
    kind: AuthFailureKind.sessionExpired,
    message: 'Your session has ended. Please sign in again.',
  );
}

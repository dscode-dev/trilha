import 'package:dio/dio.dart';

import '../../../core/networking/api_client.dart';
import '../domain/account.dart';
import '../../../core/errors/app_failure.dart';
import '../domain/auth_session.dart';

/// The authentication endpoints the app depends on.
///
/// Declared as an interface so tests can substitute the HTTP boundary — the one
/// place §51 sanctions a fake — without reaching for a real network or platform
/// storage. [AuthApi] is the only production implementation.
abstract interface class AuthEndpoints {
  Future<AuthSession> register({
    required String email,
    required String password,
    required String username,
    required String displayName,
  });

  Future<AuthSession> login({required String email, required String password});

  Future<AuthSession> refresh(String refreshToken);

  Future<void> logout(String accessToken);

  Future<void> logoutAll(String accessToken);

  Future<Account> me(String accessToken);

  Future<Account> updateProfile(
    String accessToken, {
    String? username,
    String? displayName,
    Object? bio,
  });

  Future<void> changePassword(
    String accessToken, {
    required String currentPassword,
    required String newPassword,
  });
}

/// Talks to the real API.
///
/// Every method translates transport failures into [AppFailure], so nothing above
/// this layer sees a `DioException` or an HTTP status.
class AuthApi implements AuthEndpoints {
  const AuthApi(this._client);

  final ApiClient _client;

  @override
  Future<AuthSession> register({
    required String email,
    required String password,
    required String username,
    required String displayName,
  }) => _session(
    () => _client.post<Map<String, dynamic>>(
      '/auth/register',
      data: <String, dynamic>{
        'email': email,
        'password': password,
        'username': username,
        'displayName': displayName,
      },
    ),
  );

  @override
  Future<AuthSession> login({
    required String email,
    required String password,
  }) => _session(
    () => _client.post<Map<String, dynamic>>(
      '/auth/login',
      data: <String, dynamic>{'email': email, 'password': password},
    ),
  );

  /// Rotates the session. The presented token is single-use on the server.
  @override
  Future<AuthSession> refresh(String refreshToken) => _session(
    () => _client.post<Map<String, dynamic>>(
      '/auth/refresh',
      data: <String, dynamic>{'refreshToken': refreshToken},
    ),
  );

  @override
  Future<void> logout(String accessToken) => _guard(
    () => _client.post<void>('/auth/logout', options: _bearer(accessToken)),
  );

  @override
  Future<void> logoutAll(String accessToken) => _guard(
    () => _client.post<void>('/auth/logout-all', options: _bearer(accessToken)),
  );

  @override
  Future<Account> me(String accessToken) async {
    final Map<String, dynamic> json = await _guard(
      () => _client.get<Map<String, dynamic>>(
        '/me',
        options: _bearer(accessToken),
      ),
    );
    return _accountFrom(json);
  }

  @override
  Future<Account> updateProfile(
    String accessToken, {
    String? username,
    String? displayName,
    Object? bio = unsetBio,
  }) async {
    final Map<String, dynamic> payload = <String, dynamic>{
      // Null-aware entries: a field the caller did not supply is simply omitted.
      'username': ?username,
      'displayName': ?displayName,
      // `bio` is tri-state — omitted leaves it alone, explicit null clears it — so
      // it cannot use the null-aware form.
      if (!identical(bio, unsetBio)) 'bio': bio,
    };

    final Map<String, dynamic> json = await _guard(
      () => _client.patch<Map<String, dynamic>>(
        '/me/profile',
        data: payload,
        options: _bearer(accessToken),
      ),
    );
    return _accountFrom(json);
  }

  /// Succeeds only with the correct current password. Every session is then revoked
  /// server-side, so the caller must discard its own session too.
  @override
  Future<void> changePassword(
    String accessToken, {
    required String currentPassword,
    required String newPassword,
  }) => _guard(
    () => _client.post<Map<String, dynamic>>(
      '/me/change-password',
      data: <String, dynamic>{
        'currentPassword': currentPassword,
        'newPassword': newPassword,
      },
      options: _bearer(accessToken),
    ),
  );

  /// Marker meaning "this field was not supplied", so that an explicit `null` can
  /// still mean "clear it". A nullable parameter alone cannot express both.
  static const Object unsetBio = Object();

  Options _bearer(String accessToken) => Options(
    headers: <String, String>{'Authorization': 'Bearer $accessToken'},
  );

  Future<AuthSession> _session(
    Future<Map<String, dynamic>> Function() request,
  ) async {
    final Map<String, dynamic> json = await _guard(request);

    final Object? accessToken = json['accessToken'];
    final Object? refreshToken = json['refreshToken'];
    final Object? expiresIn = json['expiresIn'];

    if (accessToken is! String ||
        refreshToken is! String ||
        expiresIn is! num) {
      throw const AppFailure(
        kind: FailureKind.unknown,
        message: 'Trilha returned an unexpected response. Please try again.',
      );
    }

    return AuthSession(
      accessToken: accessToken,
      refreshToken: refreshToken,
      expiresAt: DateTime.now().toUtc().add(
        Duration(seconds: expiresIn.toInt()),
      ),
    );
  }

  Future<T> _guard<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on Object catch (error) {
      throw AppFailure.from(error);
    }
  }

  Account _accountFrom(Map<String, dynamic> json) {
    final Object? profile = json['profile'];
    final Map<String, dynamic> fields = profile is Map<String, dynamic>
        ? profile
        : <String, dynamic>{};

    return Account(
      id: json['id']! as String,
      email: json['email']! as String,
      username: fields['username']! as String,
      displayName: fields['displayName']! as String,
      bio: fields['bio'] as String?,
      avatarUrl: fields['avatarUrl'] as String?,
    );
  }
}

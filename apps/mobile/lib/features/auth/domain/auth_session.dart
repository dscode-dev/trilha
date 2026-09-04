import 'package:equatable/equatable.dart';

/// The credentials that prove an active session.
///
/// The access token is deliberately **not** persisted (§37): it lives in memory for
/// its short lifetime and is re-derived from the refresh token on next launch. Only
/// the refresh token reaches secure storage.
class AuthSession extends Equatable {
  const AuthSession({
    required this.accessToken,
    required this.refreshToken,
    required this.expiresAt,
  });

  final String accessToken;
  final String refreshToken;
  final DateTime expiresAt;

  /// Whether the access token should be refreshed before use.
  ///
  /// A margin avoids sending a token that expires in flight; without it a request
  /// issued at the last second arrives already invalid.
  bool isExpiring({
    DateTime? now,
    Duration margin = const Duration(seconds: 30),
  }) {
    final DateTime reference = now ?? DateTime.now().toUtc();
    return !expiresAt.isAfter(reference.add(margin));
  }

  AuthSession copyWith({
    String? accessToken,
    String? refreshToken,
    DateTime? expiresAt,
  }) {
    return AuthSession(
      accessToken: accessToken ?? this.accessToken,
      refreshToken: refreshToken ?? this.refreshToken,
      expiresAt: expiresAt ?? this.expiresAt,
    );
  }

  @override
  List<Object?> get props => <Object?>[accessToken, refreshToken, expiresAt];

  /// Never print token material, even accidentally through an interpolated object.
  @override
  String toString() => 'AuthSession(expiresAt: $expiresAt)';
}

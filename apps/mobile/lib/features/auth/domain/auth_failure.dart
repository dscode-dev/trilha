import 'package:equatable/equatable.dart';

import '../../../core/errors/app_exception.dart';

/// What went wrong, expressed in terms the UI can act on (§45).
///
/// Screens switch on this rather than on HTTP status codes, so the presentation
/// layer never has to know that 409 means "username taken".
enum AuthFailureKind {
  invalidCredentials,
  emailAlreadyInUse,
  usernameAlreadyInUse,
  weakPassword,
  rateLimited,
  sessionExpired,
  accountDisabled,
  networkUnavailable,
  validation,
  unknown,
}

/// A failure from an authentication or profile operation.
class AuthFailure extends Equatable implements Exception {
  const AuthFailure({
    required this.kind,
    required this.message,
    this.retryAfterSeconds,
  });

  /// Maps a transport-level error onto the authentication vocabulary.
  ///
  /// The server's machine code is authoritative when present; the transport `kind`
  /// is the fallback for failures that never reached the API.
  factory AuthFailure.from(Object error) {
    if (error is AuthFailure) return error;

    if (error is ApiException) {
      final AuthFailureKind kind = switch (error.code) {
        'INVALID_CREDENTIALS' => AuthFailureKind.invalidCredentials,
        'EMAIL_ALREADY_IN_USE' => AuthFailureKind.emailAlreadyInUse,
        'USERNAME_ALREADY_IN_USE' => AuthFailureKind.usernameAlreadyInUse,
        'WEAK_PASSWORD' => AuthFailureKind.weakPassword,
        'VALIDATION_ERROR' => AuthFailureKind.validation,
        'TOO_MANY_REQUESTS' => AuthFailureKind.rateLimited,
        'SESSION_EXPIRED' || 'INVALID_TOKEN' => AuthFailureKind.sessionExpired,
        'ACCOUNT_DISABLED' => AuthFailureKind.accountDisabled,
        _ => _fromTransport(error.kind),
      };

      return AuthFailure(kind: kind, message: error.message);
    }

    if (error is AppException) {
      return AuthFailure(
        kind: _fromTransport(error.kind),
        message: error.message,
      );
    }

    return const AuthFailure(
      kind: AuthFailureKind.unknown,
      message: 'Something went wrong. Please try again.',
    );
  }

  static AuthFailureKind _fromTransport(AppErrorKind kind) => switch (kind) {
    AppErrorKind.network ||
    AppErrorKind.timeout => AuthFailureKind.networkUnavailable,
    AppErrorKind.unauthorized => AuthFailureKind.sessionExpired,
    _ => AuthFailureKind.unknown,
  };

  final AuthFailureKind kind;

  /// Safe to show a user. Never a stack trace or a technical detail (§41).
  final String message;

  /// Present when the server asked the client to back off.
  final int? retryAfterSeconds;

  /// Whether the same input could plausibly succeed on a retry.
  bool get isRetryable =>
      kind == AuthFailureKind.networkUnavailable ||
      kind == AuthFailureKind.unknown;

  @override
  List<Object?> get props => <Object?>[kind, message, retryAfterSeconds];
}

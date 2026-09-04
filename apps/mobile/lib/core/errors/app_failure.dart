import 'package:equatable/equatable.dart';

import 'app_exception.dart';

/// What went wrong, expressed in terms the UI can act on (§45).
///
/// Screens switch on this rather than on HTTP status codes, so the presentation
/// layer never has to know that 409 means "username taken".
///
/// Lives in `core/` rather than in a feature: auth, places and everything after
/// them need the same vocabulary, and `features/README.md` requires that what two
/// features share moves out of either one.
enum FailureKind {
  invalidCredentials,
  emailAlreadyInUse,
  usernameAlreadyInUse,
  weakPassword,
  rateLimited,
  sessionExpired,
  accountDisabled,
  networkUnavailable,
  validation,

  /// The caller abandoned the request — a map pan superseding its own query, for
  /// instance. Never surfaced to the user: nothing went wrong.
  cancelled,

  /// The request was fine but no route connects the two points.
  notRoutable,

  /// An upstream service Trilha depends on is down or timed out. Distinct from
  /// [networkUnavailable]: the user's connection is fine, ours is not.
  providerUnavailable,

  unknown,
}

/// A failure from any API-backed operation.
class AppFailure extends Equatable implements Exception {
  const AppFailure({
    required this.kind,
    required this.message,
    this.retryAfterSeconds,
  });

  /// Maps a transport-level error onto the authentication vocabulary.
  ///
  /// The server's machine code is authoritative when present; the transport `kind`
  /// is the fallback for failures that never reached the API.
  factory AppFailure.from(Object error) {
    if (error is AppFailure) return error;

    if (error is ApiException) {
      final FailureKind kind = switch (error.code) {
        'INVALID_CREDENTIALS' => FailureKind.invalidCredentials,
        'EMAIL_ALREADY_IN_USE' => FailureKind.emailAlreadyInUse,
        'USERNAME_ALREADY_IN_USE' => FailureKind.usernameAlreadyInUse,
        'WEAK_PASSWORD' => FailureKind.weakPassword,
        'VALIDATION_ERROR' => FailureKind.validation,
        'TOO_MANY_REQUESTS' => FailureKind.rateLimited,
        'SESSION_EXPIRED' || 'INVALID_TOKEN' => FailureKind.sessionExpired,
        'ACCOUNT_DISABLED' => FailureKind.accountDisabled,
        /* Routing (PR-03). */
        'ROUTE_NOT_FOUND' => FailureKind.notRoutable,
        'INVALID_ROUTE_REQUEST' => FailureKind.validation,
        'PROVIDER_TIMEOUT' ||
        'PROVIDER_UNAVAILABLE' ||
        'PROVIDER_RATE_LIMITED' => FailureKind.providerUnavailable,
        _ => _fromTransport(error.kind),
      };

      return AppFailure(kind: kind, message: error.message);
    }

    if (error is AppException) {
      return AppFailure(
        kind: _fromTransport(error.kind),
        message: error.message,
      );
    }

    return const AppFailure(
      kind: FailureKind.unknown,
      message: 'Something went wrong. Please try again.',
    );
  }

  static FailureKind _fromTransport(AppErrorKind kind) => switch (kind) {
    AppErrorKind.network ||
    AppErrorKind.timeout => FailureKind.networkUnavailable,
    AppErrorKind.unauthorized => FailureKind.sessionExpired,
    _ => FailureKind.unknown,
  };

  final FailureKind kind;

  /// Safe to show a user. Never a stack trace or a technical detail (§41).
  final String message;

  /// Present when the server asked the client to back off.
  final int? retryAfterSeconds;

  /// Whether the same input could plausibly succeed on a retry.
  ///
  /// An upstream outage is retryable; "no route exists between these points" is not,
  /// however many times it is asked.
  bool get isRetryable =>
      kind == FailureKind.networkUnavailable ||
      kind == FailureKind.providerUnavailable ||
      kind == FailureKind.unknown;

  @override
  List<Object?> get props => <Object?>[kind, message, retryAfterSeconds];
}

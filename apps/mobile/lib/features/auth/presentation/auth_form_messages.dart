import '../../../core/errors/app_failure.dart';

/// Turns a failure into words for a person (§41, §45).
///
/// Screens never render `failure.kind` or an HTTP status; they call this. Keeping the
/// mapping in one place is also what stops a technical string leaking into the UI.
abstract final class AuthFormMessages {
  const AuthFormMessages._();

  static String forFailure(AppFailure failure) => switch (failure.kind) {
    FailureKind.invalidCredentials => 'Email or password is incorrect.',
    FailureKind.emailAlreadyInUse =>
      'That email is already registered. Try signing in.',
    FailureKind.usernameAlreadyInUse => 'That username is taken. Try another.',
    FailureKind.weakPassword =>
      'Choose a longer password — at least 12 characters.',
    FailureKind.validation => 'Please check the highlighted fields.',
    FailureKind.rateLimited => _throttled(failure.retryAfterSeconds),
    FailureKind.sessionExpired => 'Your session ended. Please sign in again.',
    FailureKind.accountDisabled =>
      'This account is unavailable. Contact support.',
    FailureKind.networkUnavailable =>
      'No connection. Check your network and try again.',
    FailureKind.unknown => 'Something went wrong. Please try again.',
    /* A cancelled request is the app superseding its own work; there is nothing to
       tell the user, but the switch must stay exhaustive. */
    FailureKind.cancelled => '',
    /* Routing failures never reach an auth form; handled by the routing surface. */
    FailureKind.notRoutable || FailureKind.providerUnavailable =>
      'Something went wrong. Please try again.',
  };

  static String _throttled(int? retryAfterSeconds) {
    if (retryAfterSeconds == null || retryAfterSeconds <= 0) {
      return 'Too many attempts. Please wait a moment and try again.';
    }
    final int minutes = (retryAfterSeconds / 60).ceil();
    return minutes <= 1
        ? 'Too many attempts. Try again in about a minute.'
        : 'Too many attempts. Try again in about $minutes minutes.';
  }
}

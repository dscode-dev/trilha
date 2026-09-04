import '../domain/auth_failure.dart';

/// Turns a failure into words for a person (§41, §45).
///
/// Screens never render `failure.kind` or an HTTP status; they call this. Keeping the
/// mapping in one place is also what stops a technical string leaking into the UI.
abstract final class AuthFormMessages {
  const AuthFormMessages._();

  static String forFailure(AuthFailure failure) => switch (failure.kind) {
    AuthFailureKind.invalidCredentials => 'Email or password is incorrect.',
    AuthFailureKind.emailAlreadyInUse =>
      'That email is already registered. Try signing in.',
    AuthFailureKind.usernameAlreadyInUse =>
      'That username is taken. Try another.',
    AuthFailureKind.weakPassword =>
      'Choose a longer password — at least 12 characters.',
    AuthFailureKind.validation => 'Please check the highlighted fields.',
    AuthFailureKind.rateLimited => _throttled(failure.retryAfterSeconds),
    AuthFailureKind.sessionExpired =>
      'Your session ended. Please sign in again.',
    AuthFailureKind.accountDisabled =>
      'This account is unavailable. Contact support.',
    AuthFailureKind.networkUnavailable =>
      'No connection. Check your network and try again.',
    AuthFailureKind.unknown => 'Something went wrong. Please try again.',
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

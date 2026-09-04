/// Client-side form validation (§42).
///
/// Mirrors the server's rules so obvious mistakes are caught before a round trip.
/// It is a convenience, never the authority: the server re-validates everything, and
/// its answer wins.
abstract final class AuthValidators {
  const AuthValidators._();

  /// Matches the backend's minimum. Kept in sync deliberately — a client that
  /// accepts what the server rejects produces a confusing round trip.
  static const int passwordMinLength = 12;
  static const int usernameMinLength = 3;
  static const int usernameMaxLength = 30;

  static final RegExp _email = RegExp(r'^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$');
  static final RegExp _username = RegExp(r'^[a-z0-9]+([_-][a-z0-9]+)*$');

  static String? email(String? value) {
    final String text = (value ?? '').trim();
    if (text.isEmpty) return 'Enter your email';
    if (!_email.hasMatch(text)) return 'Enter a valid email address';
    return null;
  }

  static String? password(String? value) {
    final String text = value ?? '';
    if (text.isEmpty) return 'Enter a password';
    if (text.length < passwordMinLength) {
      return 'Use at least $passwordMinLength characters';
    }
    return null;
  }

  /// Login must not apply the strength policy: an existing password predates any
  /// later change to it, and echoing the rules here would leak them pre-auth.
  static String? loginPassword(String? value) =>
      (value ?? '').isEmpty ? 'Enter your password' : null;

  static String? username(String? value) {
    final String text = (value ?? '').trim();
    if (text.isEmpty) return 'Choose a username';
    if (text.length < usernameMinLength) {
      return 'Use at least $usernameMinLength characters';
    }
    if (text.length > usernameMaxLength) {
      return 'Use at most $usernameMaxLength characters';
    }
    if (!_username.hasMatch(text.toLowerCase())) {
      return 'Use letters and numbers, separated by - or _';
    }
    return null;
  }

  static String? displayName(String? value) {
    final String text = (value ?? '').trim();
    if (text.isEmpty) return 'Enter your name';
    if (text.length > 80) return 'Use at most 80 characters';
    return null;
  }
}

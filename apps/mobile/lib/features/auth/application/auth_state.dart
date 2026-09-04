import 'package:equatable/equatable.dart';

import '../domain/account.dart';
import '../../../core/errors/app_failure.dart';

/// Where the app is in the authentication lifecycle (§36).
///
/// The router derives its destination from this, so navigation is a function of
/// state rather than a side effect scattered across screens.
sealed class AuthState extends Equatable {
  const AuthState();

  @override
  List<Object?> get props => <Object?>[];
}

/// Restoring a stored session. The first frame is painted in this state, so the app
/// must never flash the login screen before it knows whether a session exists.
final class AuthBootstrapping extends AuthState {
  const AuthBootstrapping();
}

/// No usable session. The reason is carried when the user should be told why they
/// were signed out — an expired session differs from a deliberate logout.
final class AuthUnauthenticated extends AuthState {
  const AuthUnauthenticated({this.reason});

  final AppFailure? reason;

  @override
  List<Object?> get props => <Object?>[reason];
}

/// A live session with a loaded account.
final class AuthAuthenticated extends AuthState {
  const AuthAuthenticated(this.account);

  final Account account;

  @override
  List<Object?> get props => <Object?>[account];
}

extension AuthStateX on AuthState {
  bool get isAuthenticated => this is AuthAuthenticated;
  bool get isBootstrapping => this is AuthBootstrapping;

  Account? get accountOrNull => switch (this) {
    AuthAuthenticated(:final Account account) => account,
    _ => null,
  };
}

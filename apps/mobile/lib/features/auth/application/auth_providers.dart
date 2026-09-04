import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/bootstrap/providers.dart';
import '../data/auth_api.dart';
import '../data/secure_token_store.dart';
import '../domain/account.dart';
import 'auth_controller.dart';
import 'auth_state.dart';

/// Composition for the auth feature (ADR-0005).
///
/// These providers wire dependencies together; the rules live in [AuthController].

final Provider<TokenStore> tokenStoreProvider = Provider<TokenStore>(
  (ref) => SecureTokenStore(SecureTokenStore.defaultStorage()),
  name: 'tokenStore',
);

/// Overridden in tests with a fake implementation of [AuthEndpoints].
final Provider<AuthEndpoints> authApiProvider = Provider<AuthEndpoints>(
  (ref) => AuthApi(ref.watch(apiClientProvider)),
  name: 'authApi',
);

/// The session, owned for the lifetime of the app.
///
/// Not auto-disposed: dropping the session the moment no screen happened to be
/// listening would sign the user out on any navigation that unmounted every
/// listener.
final NotifierProvider<AuthController, AuthState> authControllerProvider =
    NotifierProvider<AuthController, AuthState>(
      AuthController.new,
      name: 'authController',
    );

/// The signed-in account, or null. Convenience for widgets that only need the user.
final Provider<Account?> currentAccountProvider = Provider<Account?>(
  (ref) => ref.watch(authControllerProvider).accountOrNull,
  name: 'currentAccount',
);

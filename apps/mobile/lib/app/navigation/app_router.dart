import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/application/auth_providers.dart';
import '../../features/auth/application/auth_state.dart';
import '../../features/auth/presentation/auth_routes.dart';
import '../../features/map/presentation/map_screen.dart';
import '../../features/auth/presentation/sign_in_screen.dart';
import '../../features/auth/presentation/sign_up_screen.dart';
import '../../features/profile/presentation/change_password_screen.dart';
import '../../features/profile/presentation/profile_screen.dart';
import '../../features/root/presentation/root_screen.dart';
import 'app_routes.dart';

/// Application router (§17, §36).
///
/// **Navigation is derived, not commanded.** `redirect` is the only place that
/// decides where an unauthenticated user may be, so no screen calls `go()` after
/// signing in or out. That is what keeps sign-out consistent no matter which of the
/// several paths triggered it — a tap, an expired refresh, or a password change.
final Provider<GoRouter> appRouterProvider = Provider<GoRouter>((ref) {
  final _AuthRouterListenable authListenable = _AuthRouterListenable(ref);

  final GoRouter router = GoRouter(
    initialLocation: AppRoutes.rootPath,
    debugLogDiagnostics: !const bool.fromEnvironment('dart.vm.product'),
    refreshListenable: authListenable,
    redirect: (BuildContext context, GoRouterState state) {
      final AuthState auth = ref.read(authControllerProvider);
      final String location = state.matchedLocation;

      // While restoring a stored session, hold on the splash. Deciding early would
      // flash the sign-in screen at a user who is in fact signed in (§36).
      if (auth.isBootstrapping) {
        return location == AppRoutes.rootPath ? null : AppRoutes.rootPath;
      }

      final bool onAuthSurface =
          location == AuthRoutes.loginPath ||
          location == AuthRoutes.registerPath ||
          location == AppRoutes.rootPath;

      if (!auth.isAuthenticated) {
        return onAuthSurface && location != AppRoutes.rootPath
            ? null
            : AuthRoutes.loginPath;
      }

      // Signed in: the auth surfaces and the splash are no longer valid destinations.
      return onAuthSurface ? AuthRoutes.homePath : null;
    },
    routes: <RouteBase>[
      GoRoute(
        path: AppRoutes.rootPath,
        name: AppRoutes.rootName,
        builder: (context, state) => const RootScreen(),
      ),
      GoRoute(
        path: AuthRoutes.loginPath,
        name: AuthRoutes.loginName,
        builder: (context, state) => const SignInScreen(),
      ),
      GoRoute(
        path: AuthRoutes.registerPath,
        name: AuthRoutes.registerName,
        builder: (context, state) => const SignUpScreen(),
      ),
      GoRoute(
        path: AuthRoutes.homePath,
        name: AuthRoutes.homeName,
        builder: (context, state) => const MapScreen(),
      ),
      GoRoute(
        path: AuthRoutes.profilePath,
        name: AuthRoutes.profileName,
        builder: (context, state) => const ProfileScreen(),
        routes: <RouteBase>[
          GoRoute(
            path: 'password',
            name: AuthRoutes.changePasswordName,
            builder: (context, state) => const ChangePasswordScreen(),
          ),
        ],
      ),
    ],
    errorBuilder: (context, state) =>
        RouteNotFoundScreen(location: state.uri.toString()),
  );

  ref.onDispose(() {
    router.dispose();
    authListenable.dispose();
  });

  return router;
}, name: 'appRouter');

/// Bridges Riverpod's auth state to go_router's `refreshListenable`.
///
/// go_router re-evaluates `redirect` when this notifies, which is how a session
/// ending anywhere in the app moves the user to the sign-in screen.
class _AuthRouterListenable extends ChangeNotifier {
  _AuthRouterListenable(this._ref) {
    _subscription = _ref.listen<AuthState>(authControllerProvider, (
      AuthState? previous,
      AuthState next,
    ) {
      // Only a change of phase can alter routing; a profile edit must not
      // re-trigger redirects.
      if (previous.runtimeType != next.runtimeType) notifyListeners();
    }, fireImmediately: false);
  }

  final Ref _ref;
  late final ProviderSubscription<AuthState> _subscription;

  @override
  void dispose() {
    _subscription.close();
    super.dispose();
  }
}

/// Shown when a deep link points at a route this build does not know.
///
/// A real screen rather than a crash: an old link must not take the app down (§20).
class RouteNotFoundScreen extends StatelessWidget {
  const RouteNotFoundScreen({required this.location, super.key});

  final String location;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);

    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(
                Icons.explore_off_outlined,
                size: 48,
                color: theme.colorScheme.onSurfaceVariant,
              ),
              const SizedBox(height: 16),
              Text(
                'This page could not be found',
                style: theme.textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Text(
                location,
                style: theme.textTheme.bodyMedium,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 24),
              FilledButton(
                onPressed: () => context.goNamed(AppRoutes.rootName),
                child: const Text('Go to start'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

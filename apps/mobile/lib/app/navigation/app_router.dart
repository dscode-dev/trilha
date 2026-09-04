import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/root/presentation/root_screen.dart';
import 'app_routes.dart';

/// Application router (§17).
///
/// PR-00 establishes the routing seam and a single real destination. The tab shell
/// and the product destinations arrive with the PRs that own those screens — inventing
/// them now would mean shipping fake screens.
///
/// `go_router` already parses inbound URLs, so deep linking needs route definitions
/// rather than extra machinery.
final Provider<GoRouter> appRouterProvider = Provider<GoRouter>((ref) {
  final GoRouter router = GoRouter(
    initialLocation: AppRoutes.rootPath,
    // Kept off in release: the observer logs every navigation.
    debugLogDiagnostics: !const bool.fromEnvironment('dart.vm.product'),
    routes: <RouteBase>[
      GoRoute(
        path: AppRoutes.rootPath,
        name: AppRoutes.rootName,
        builder: (context, state) => const RootScreen(),
      ),
    ],
    errorBuilder: (context, state) =>
        RouteNotFoundScreen(location: state.uri.toString()),
  );

  ref.onDispose(router.dispose);
  return router;
}, name: 'appRouter');

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

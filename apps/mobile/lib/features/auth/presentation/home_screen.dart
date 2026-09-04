import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/theme/app_spacing.dart';
import '../../../shared/widgets/initials_avatar.dart';
import '../../../shared/widgets/trilha_logo.dart';
import '../application/auth_providers.dart';
import '../domain/account.dart';
import 'auth_routes.dart';

/// The authenticated root (§44).
///
/// Proves a real session end to end and provides a way into the profile. It is
/// deliberately **not** a product home: there is no feed, no map, no trails and no
/// statistics, because none of those exist yet and inventing them would misrepresent
/// what has been built.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ThemeData theme = Theme.of(context);
    final Account? account = ref.watch(currentAccountProvider);

    if (account == null) {
      // The router redirects on sign-out; this covers the frame in between.
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Trilha'),
        actions: <Widget>[
          IconButton(
            icon: const Icon(Icons.person_outline),
            tooltip: 'Your profile',
            onPressed: () => context.goNamed(AuthRoutes.profileName),
          ),
        ],
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  const TrilhaLogo(size: 120),
                  const SizedBox(height: AppSpacing.lg),
                  Semantics(
                    header: true,
                    child: Text(
                      'Hello, ${account.displayName}',
                      style: theme.textTheme.headlineMedium,
                      textAlign: TextAlign.center,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.sm),
                  Text(
                    'Your account is ready.',
                    style: theme.textTheme.bodyLarge,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: AppSpacing.xl),
                  Card(
                    child: ListTile(
                      leading: InitialsAvatar(
                        initials: account.initials,
                        seed: account.username,
                        radius: 22,
                      ),
                      title: Text(account.displayName),
                      subtitle: Text('@${account.username}'),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => context.goNamed(AuthRoutes.profileName),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

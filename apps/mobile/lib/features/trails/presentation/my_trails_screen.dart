import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_spacing.dart';
import '../application/trail_list_controller.dart';
import '../application/trail_providers.dart';
import '../domain/trail.dart';

/// "Minhas trilhas" (§68).
///
/// A list of the user's own compositions and nothing more. Not a feed: there is no
/// author, no like, no save-someone-else's — a Trail is private to whoever built it,
/// and this screen has no code that could suggest otherwise (§5, §72).
class MyTrailsScreen extends ConsumerStatefulWidget {
  const MyTrailsScreen({this.onOpen, super.key});

  /// Called with a trail id when the user picks one, so the host can open the builder.
  final void Function(String trailId)? onOpen;

  @override
  ConsumerState<MyTrailsScreen> createState() => _MyTrailsScreenState();
}

class _MyTrailsScreenState extends ConsumerState<MyTrailsScreen> {
  @override
  void initState() {
    super.initState();
    /* After the first frame, so the provider is not written to during a build. */
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(ref.read(trailListControllerProvider.notifier).load());
    });
  }

  @override
  Widget build(BuildContext context) {
    final TrailListState state = ref.watch(trailListControllerProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Minhas trilhas')),
      body: switch (state) {
        TrailListState(isLoading: true, trails: []) => const Center(
          child: CircularProgressIndicator(),
        ),
        TrailListState(failure: final failure?) => _Message(
          icon: Icons.error_outline,
          message: failure.message,
          isError: true,
          onRetry: () =>
              unawaited(ref.read(trailListControllerProvider.notifier).load()),
        ),
        TrailListState(isEmpty: true) => const _Message(
          icon: Icons.route_outlined,
          message: 'Você ainda não montou nenhuma trilha.',
        ),
        _ => RefreshIndicator(
          onRefresh: () =>
              ref.read(trailListControllerProvider.notifier).load(),
          child: ListView.builder(
            itemCount: state.trails.length + (state.hasMore ? 1 : 0),
            itemBuilder: (BuildContext context, int index) {
              if (index >= state.trails.length) {
                return Padding(
                  padding: const EdgeInsets.all(AppSpacing.md),
                  child: Center(
                    child: TextButton(
                      onPressed: () => unawaited(
                        ref
                            .read(trailListControllerProvider.notifier)
                            .loadMore(),
                      ),
                      child: const Text('Carregar mais'),
                    ),
                  ),
                );
              }

              final TrailSummary trail = state.trails[index];

              return ListTile(
                leading: Icon(
                  trail.status == TrailStatus.finalized
                      ? Icons.check_circle_outline
                      : Icons.edit_outlined,
                ),
                title: Text(trailTitle(trail)),
                subtitle: Text(trailSubtitle(trail)),
                onTap: () => widget.onOpen?.call(trail.id),
              );
            },
          ),
        ),
      },
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({
    required this.icon,
    required this.message,
    this.isError = false,
    this.onRetry,
  });

  final IconData icon;
  final String message;
  final bool isError;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final ColorScheme colors = Theme.of(context).colorScheme;
    final Color tone = isError ? colors.error : colors.onSurfaceVariant;

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(icon, color: tone),
            const SizedBox(height: AppSpacing.sm),
            Text(
              message,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium
                  ?.copyWith(color: tone),
            ),
            if (onRetry != null) ...<Widget>[
              const SizedBox(height: AppSpacing.sm),
              TextButton(
                onPressed: onRetry,
                child: const Text('Tentar de novo'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

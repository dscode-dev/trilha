import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_radius.dart';
import '../../../app/theme/app_spacing.dart';
import '../../../core/errors/app_failure.dart';
import '../application/trail_controller.dart';
import '../application/trail_providers.dart';
import '../application/trail_state.dart';
import '../domain/trail.dart';

/// The Trail Builder (§59).
///
/// A draggable sheet over the map, not a wizard: composing a trail is an iterative
/// act — add, look, reorder, look again — and a linear flow would make every glance at
/// the map a step backwards.
///
/// The header states what the trail *is* (endpoints, distance, time); the list is what
/// the user manipulates; the actions are the two things they can do when finished.
class TrailBuilderSheet extends ConsumerWidget {
  const TrailBuilderSheet({
    this.onAddStop,
    this.onClose,
    this.onStopTap,
    super.key,
  });

  /// Opens whatever selection surface the host provides — search, or discovery (§65).
  final VoidCallback? onAddStop;
  final VoidCallback? onClose;
  final void Function(TrailStop stop)? onStopTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final TrailState state = ref.watch(trailControllerProvider);
    final Trail? trail = state.trail;
    final ThemeData theme = Theme.of(context);

    if (trail == null) {
      return const SizedBox.shrink();
    }

    return Material(
      elevation: 8,
      borderRadius: const BorderRadius.vertical(top: AppRadius.lg),
      color: theme.colorScheme.surface,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              _Header(trail: trail, onClose: onClose),
              if (state.isMutating) const LinearProgressIndicator(minHeight: 2),
              if (state.conflictDetected) const _ConflictBanner(),
              if (state.failure != null && !state.conflictDetected)
                _FailureBanner(failure: state.failure!),
              Flexible(
                child: _StopList(
                  trail: trail,
                  enabled: state.canMutate,
                  onStopTap: onStopTap,
                ),
              ),
              _Actions(state: state, onAddStop: onAddStop),
            ],
          ),
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.trail, this.onClose});

  final Trail trail;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final TrailRoute? route = trail.route;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('Minha trilha', style: theme.textTheme.titleMedium),
                const SizedBox(height: AppSpacing.xs),
                Text(
                  '${trail.origin.label ?? 'Origem'} → ${trail.destination.label ?? 'Destino'}',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: AppSpacing.xs),
                if (route != null)
                  Text(
                    _summary(trail, route),
                    style: theme.textTheme.titleSmall,
                  )
                else
                  Text(
                    /* Honest about the one case where a trail exists without a route:
                       the provider was unreachable when it was created (§26). */
                    'Rota ainda não calculada',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.error,
                    ),
                  ),
              ],
            ),
          ),
          if (onClose != null)
            IconButton(
              icon: const Icon(Icons.close),
              tooltip: 'Fechar',
              onPressed: onClose,
            ),
        ],
      ),
    );
  }

  /// "145 km · 2h11 · +23 min", with the detour only when it was measured (§38).
  static String _summary(Trail trail, TrailRoute route) {
    final List<String> parts = <String>[
      formatRouteDistance(route.distanceMeters),
      formatDuration(route.durationSeconds),
    ];

    final TrailMetrics? detour = trail.detour;
    if (detour != null && detour.durationSeconds > 0) {
      parts.add('+${formatDuration(detour.durationSeconds)}');
    }

    return parts.join(' · ');
  }
}

/// The stops, reorderable by drag (§55, §62).
class _StopList extends ConsumerWidget {
  const _StopList({required this.trail, required this.enabled, this.onStopTap});

  final Trail trail;
  final bool enabled;
  final void Function(TrailStop stop)? onStopTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final TrailController controller = ref.read(
      trailControllerProvider.notifier,
    );

    if (trail.stops.isEmpty) {
      return Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Text(
          'Nenhuma parada ainda. A trilha vai direto de A a B.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
      );
    }

    return ReorderableListView.builder(
      shrinkWrap: true,
      buildDefaultDragHandles: false,
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      itemCount: trail.stops.length,
      /* One mutation on drop, never one per frame: each reorder re-routes upstream
         (§55, §95). `onReorderItem` rather than `onReorder` because it hands back an
         index already adjusted for the removed row — the off-by-one that variant
         exists to remove. */
      onReorderItem: (int oldIndex, int newIndex) =>
          unawaited(controller.reorderStops(oldIndex, newIndex)),
      itemBuilder: (BuildContext context, int index) {
        final TrailStop stop = trail.stops[index];

        return TrailStopTile(
          key: ValueKey<String>(stop.id),
          stop: stop,
          index: index,
          enabled: enabled,
          onTap: onStopTap == null ? null : () => onStopTap?.call(stop),
          onRemove: enabled
              ? () => unawaited(controller.removeStop(stop.id))
              : null,
        );
      },
    );
  }
}

/// One stop: its number, its name, a drag handle and a remove button (§62).
class TrailStopTile extends StatelessWidget {
  const TrailStopTile({
    required this.stop,
    required this.index,
    required this.enabled,
    this.onTap,
    this.onRemove,
    super.key,
  });

  final TrailStop stop;
  final int index;
  final bool enabled;
  final VoidCallback? onTap;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);

    return ListTile(
      contentPadding: EdgeInsets.zero,
      /* The visiting order, not the category icon: while the builder is open, "which
         one is third" is the question the user is actually asking (§62). */
      leading: CircleAvatar(
        radius: 14,
        backgroundColor: theme.colorScheme.primary,
        child: Text(
          '${stop.position}',
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w700,
            color: theme.colorScheme.onPrimary,
          ),
        ),
      ),
      title: Text(stop.placeName, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(stop.placeCategoryId, style: theme.textTheme.bodySmall),
      onTap: onTap,
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          IconButton(
            icon: const Icon(Icons.close),
            tooltip: 'Remover ${stop.placeName}',
            onPressed: onRemove,
          ),
          ReorderableDragStartListener(
            index: index,
            enabled: enabled,
            child: const Padding(
              padding: EdgeInsets.all(AppSpacing.sm),
              child: Icon(Icons.drag_handle),
            ),
          ),
        ],
      ),
    );
  }
}

class _Actions extends ConsumerWidget {
  const _Actions({required this.state, this.onAddStop});

  final TrailState state;
  final VoidCallback? onAddStop;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final TrailController controller = ref.read(
      trailControllerProvider.notifier,
    );
    final Trail? trail = state.trail;
    if (trail == null) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md,
        AppSpacing.sm,
        AppSpacing.md,
        0,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          OutlinedButton.icon(
            icon: const Icon(Icons.add_location_alt_outlined),
            label: Text(
              trail.isFull
                  ? 'Limite de ${trail.maxStops} paradas'
                  : 'Adicionar parada',
            ),
            onPressed: state.canMutate && !trail.isFull ? onAddStop : null,
          ),
          const SizedBox(height: AppSpacing.sm),
          Row(
            children: <Widget>[
              /* No "save" button: every change is already persisted, and offering one
                 would imply the previous edits were not (§66). */
              Expanded(
                child: Text(
                  trail.status == TrailStatus.finalized
                      ? 'Trilha concluída'
                      : 'Salva automaticamente',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              if (!trail.routeIsCurrent)
                TextButton(
                  onPressed: state.canMutate
                      ? () => unawaited(controller.recalculate())
                      : null,
                  child: const Text('Atualizar rota'),
                ),
              FilledButton(
                onPressed:
                    state.canMutate &&
                        trail.routeIsCurrent &&
                        trail.status != TrailStatus.finalized
                    ? () => unawaited(controller.finalize())
                    : null,
                child: const Text('Concluir'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// A conflict is not a failure to retry — it is news (§78).
class _ConflictBanner extends ConsumerWidget {
  const _ConflictBanner();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ColorScheme colors = Theme.of(context).colorScheme;

    return Container(
      margin: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md,
        vertical: AppSpacing.sm,
      ),
      padding: const EdgeInsets.all(AppSpacing.sm),
      decoration: BoxDecoration(
        color: colors.secondaryContainer,
        borderRadius: AppRadius.allSm,
      ),
      child: Row(
        children: <Widget>[
          Icon(
            Icons.sync_problem,
            size: 18,
            color: colors.onSecondaryContainer,
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              'Esta trilha mudou em outro lugar. Recarregue para ver o estado atual.',
              style: Theme.of(context).textTheme.bodySmall
                  ?.copyWith(color: colors.onSecondaryContainer),
            ),
          ),
          TextButton(
            onPressed: () => unawaited(
              ref.read(trailControllerProvider.notifier).reloadAfterConflict(),
            ),
            child: const Text('Recarregar'),
          ),
        ],
      ),
    );
  }
}

class _FailureBanner extends StatelessWidget {
  const _FailureBanner({required this.failure});

  final AppFailure failure;

  @override
  Widget build(BuildContext context) {
    final ColorScheme colors = Theme.of(context).colorScheme;

    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md,
        vertical: AppSpacing.sm,
      ),
      child: Row(
        children: <Widget>[
          Icon(Icons.error_outline, size: 18, color: colors.error),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              trailFailureMessage(failure),
              style: Theme.of(context).textTheme.bodySmall
                  ?.copyWith(color: colors.error),
            ),
          ),
        ],
      ),
    );
  }
}

/// Turns a failure into words (§56 of PR-03, §78).
String trailFailureMessage(AppFailure failure) => switch (failure.kind) {
  FailureKind.conflict =>
    'Esta trilha mudou em outro lugar. Recarregue para ver o estado atual.',
  FailureKind.trailStopDuplicate => 'Esse lugar já é uma parada desta trilha.',
  FailureKind.trailStopLimitReached =>
    'Esta trilha já tem o número máximo de paradas.',
  FailureKind.trailRouteStale => 'Atualize a rota antes de concluir a trilha.',
  FailureKind.networkUnavailable =>
    'Sem conexão. Verifique sua rede e tente de novo.',
  FailureKind.sessionExpired => 'Sua sessão terminou. Entre novamente.',
  FailureKind.rateLimited =>
    'Muitas alterações em pouco tempo. Aguarde um momento.',
  FailureKind.notRoutable => 'Não há rota passando por essa parada.',
  FailureKind.providerUnavailable =>
    'Não foi possível calcular a rota agora. Tente de novo em instantes.',
  FailureKind.validation => 'Não foi possível aplicar essa alteração.',
  _ => 'Algo deu errado. Tente de novo.',
};

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_radius.dart';
import '../../../app/theme/app_spacing.dart';
import '../../../core/errors/app_failure.dart';
import '../../places/application/places_providers.dart';
import '../../places/domain/place.dart';
import '../application/discovery_controller.dart';
import '../application/discovery_providers.dart';
import '../application/discovery_state.dart';
import '../domain/route_candidate.dart';

/// "Descobertas pelo caminho" (§55, §58).
///
/// A sheet over the map rather than a screen of its own: the route is what the user is
/// reasoning about, and a full-screen list would hide the thing the detour is measured
/// against.
///
/// Every card shows what Trilha actually knows — a name, a category, how much longer
/// the trip becomes, and a one-line reason. There is no rating, no safety flag and no
/// "recommended by N people", because none of those exist in the product yet and
/// inventing them here would make the screen lie (§58, §87).
class DiscoverySheet extends ConsumerWidget {
  const DiscoverySheet({this.onCandidateTap, super.key});

  /// Called when the user picks a candidate, so the host can move the map (§57).
  final void Function(RouteCandidate candidate)? onCandidateTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ThemeData theme = Theme.of(context);

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
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                child: Text(
                  'Descobertas pelo caminho',
                  style: theme.textTheme.titleMedium,
                ),
              ),
              const SizedBox(height: AppSpacing.sm),
              const _DetourFilter(),
              const SizedBox(height: AppSpacing.sm),
              const _CategoryFilters(),
              const SizedBox(height: AppSpacing.sm),
              Flexible(child: _DiscoveryBody(onCandidateTap: onCandidateTap)),
            ],
          ),
        ),
      ),
    );
  }
}

/// How much extra time the user will accept (§37, §61).
///
/// Three coarse options rather than a slider: the difference between 28 and 32 minutes
/// is not a judgement anyone makes, and every change costs a route calculation and a
/// travel-cost matrix upstream.
///
/// This filters *suggestions* only. A place beyond the ceiling can still be added to a
/// trail by hand — it simply is not offered.
class _DetourFilter extends ConsumerWidget {
  const _DetourFilter();

  static const List<int> _options = <int>[15, 30, 60];
  static const int _serverDefault = 30;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final DiscoveryState state = ref.watch(discoveryControllerProvider);
    final DiscoveryController controller = ref.read(
      discoveryControllerProvider.notifier,
    );
    final int selected = state.maxDetourMinutes ?? _serverDefault;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: Row(
        children: <Widget>[
          Text(
            'Desvio até',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: SegmentedButton<int>(
              showSelectedIcon: false,
              segments: <ButtonSegment<int>>[
                for (final int minutes in _options)
                  ButtonSegment<int>(
                    value: minutes,
                    label: Text('$minutes min'),
                  ),
              ],
              selected: <int>{selected},
              onSelectionChanged: state.isLoading
                  ? null
                  : (Set<int> choice) =>
                        unawaited(controller.setMaxDetourMinutes(choice.first)),
            ),
          ),
        ],
      ),
    );
  }
}

/// Category chips, drawn from the real Places taxonomy (§23, §60).
class _CategoryFilters extends ConsumerWidget {
  const _CategoryFilters();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final DiscoveryState state = ref.watch(discoveryControllerProvider);
    final DiscoveryController controller = ref.read(
      discoveryControllerProvider.notifier,
    );

    /* The same categories the rest of the app uses. A second hard-coded list here
       would drift from the server's the first time one is added (§23). */
    final AsyncValue<List<PlaceCategory>> categories = ref.watch(
      placeCategoriesProvider,
    );

    return categories.maybeWhen(
      data: (List<PlaceCategory> all) => SizedBox(
        height: AppSpacing.minTouchTarget,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
          itemCount: all.length,
          separatorBuilder: (_, _) => const SizedBox(width: AppSpacing.sm),
          itemBuilder: (BuildContext context, int index) {
            final PlaceCategory category = all[index];
            final bool selected = state.categories.contains(category.id);

            return FilterChip(
              label: Text(category.label),
              selected: selected,
              /* Disabled mid-request rather than queueing a second one: each change
                 costs a route calculation and a matrix call upstream (§65). */
              onSelected: state.isLoading
                  ? null
                  : (_) => unawaited(controller.toggleCategory(category.id)),
            );
          },
        ),
      ),
      orElse: () => const SizedBox.shrink(),
    );
  }
}

class _DiscoveryBody extends ConsumerWidget {
  const _DiscoveryBody({this.onCandidateTap});

  final void Function(RouteCandidate candidate)? onCandidateTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final DiscoveryState state = ref.watch(discoveryControllerProvider);

    return switch (state) {
      DiscoveryIdle() => const _DiscoveryMessage(
        icon: Icons.explore_outlined,
        message: 'Calcule uma rota para ver o que há pelo caminho.',
      ),
      DiscoveryLoading() => const Padding(
        padding: EdgeInsets.all(AppSpacing.lg),
        child: Center(child: CircularProgressIndicator()),
      ),
      DiscoveryEmpty() => const _DiscoveryMessage(
        icon: Icons.search_off,
        /* An empty result is an answer, not an error — and it must not read like
           one (§52). */
        message: 'Nada por perto dentro do desvio que você aceita.',
      ),
      DiscoveryFailure(:final AppFailure failure) => _DiscoveryMessage(
        icon: Icons.error_outline,
        message: discoveryFailureMessage(failure),
        isError: true,
        onRetry: () => unawaited(
          ref.read(discoveryControllerProvider.notifier).discover(),
        ),
      ),
      DiscoverySuccess(
        :final List<RouteCandidate> candidates,
        :final String? selectedPlaceId,
      ) =>
        ListView.builder(
          shrinkWrap: true,
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
          itemCount: candidates.length,
          itemBuilder: (BuildContext context, int index) {
            final RouteCandidate candidate = candidates[index];

            return CandidateCard(
              candidate: candidate,
              selected: candidate.place.id == selectedPlaceId,
              onTap: () {
                ref
                    .read(discoveryControllerProvider.notifier)
                    .select(candidate.place.id);
                onCandidateTap?.call(candidate);
              },
            );
          },
        ),
    };
  }
}

/// One candidate (§58).
class CandidateCard extends StatelessWidget {
  const CandidateCard({
    required this.candidate,
    required this.selected,
    required this.onTap,
    super.key,
  });

  final RouteCandidate candidate;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String? reason = candidateReason(candidate);
    final String detour = formatDetour(candidate.detourDurationSeconds);

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.sm),
      /* Selection is shown by outline as well as fill, so it survives for someone who
         cannot rely on the colour difference. */
      shape: RoundedRectangleBorder(
        borderRadius: AppRadius.allMd,
        side: selected
            ? BorderSide(color: theme.colorScheme.primary, width: 2)
            : BorderSide.none,
      ),
      child: InkWell(
        onTap: onTap,
        borderRadius: AppRadius.allMd,
        child: Semantics(
          button: true,
          selected: selected,
          label:
              '${candidate.place.name}, $detour${reason == null ? '' : ', $reason'}',
          excludeSemantics: true,
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        candidate.place.name,
                        style: theme.textTheme.titleSmall,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: AppSpacing.xs),
                      Text(
                        reason == null
                            ? candidate.place.categoryId
                            : '${candidate.place.categoryId} · $reason',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                /* The extra time, not the score. 0.91423 is not something a traveller
                   can act on, and it invites comparisons across policy versions that
                   are not comparable (§59). */
                Text(detour, style: theme.textTheme.titleSmall),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _DiscoveryMessage extends StatelessWidget {
  const _DiscoveryMessage({
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

    return Padding(
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
            TextButton(onPressed: onRetry, child: const Text('Tentar de novo')),
          ],
        ],
      ),
    );
  }
}

/// Turns a failure into words (§56).
String discoveryFailureMessage(AppFailure failure) => switch (failure.kind) {
  FailureKind.networkUnavailable =>
    'Sem conexão. Verifique sua rede e tente de novo.',
  FailureKind.sessionExpired =>
    'Sua sessão terminou. Entre novamente para ver descobertas.',
  FailureKind.rateLimited =>
    'Muitas buscas em pouco tempo. Aguarde um momento.',
  FailureKind.notRoutable => 'Não há rota entre esses dois pontos.',
  FailureKind.providerUnavailable =>
    'As descobertas estão indisponíveis agora. Tente de novo em instantes.',
  _ => 'Não foi possível buscar descobertas. Tente de novo.',
};

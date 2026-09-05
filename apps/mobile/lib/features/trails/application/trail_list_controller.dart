import 'package:equatable/equatable.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../data/trails_api.dart';
import '../domain/trail.dart';
import 'trail_providers.dart';

/// "Minhas trilhas" (§68).
///
/// Summaries only — the list never carries geometry, so opening the screen costs one
/// small request however many trails someone has.
class TrailListState extends Equatable {
  const TrailListState({
    this.trails = const <TrailSummary>[],
    this.isLoading = false,
    this.failure,
    this.nextCursor,
  });

  final List<TrailSummary> trails;
  final bool isLoading;
  final AppFailure? failure;
  final String? nextCursor;

  bool get isEmpty => !isLoading && failure == null && trails.isEmpty;
  bool get hasMore => nextCursor != null;

  @override
  List<Object?> get props => <Object?>[trails, isLoading, failure, nextCursor];
}

class TrailListController extends Notifier<TrailListState> {
  TrailEndpoints get _api => ref.read(trailsApiProvider);

  @override
  TrailListState build() => const TrailListState();

  Future<void> load() async {
    state = const TrailListState(isLoading: true);

    try {
      final TrailPage page = await _api.list();
      if (!ref.mounted) return;

      state = TrailListState(trails: page.trails, nextCursor: page.nextCursor);
    } on AppFailure catch (failure) {
      if (!ref.mounted) return;
      state = TrailListState(failure: failure);
    }
  }

  /// Appends the next page (§43).
  Future<void> loadMore() async {
    final String? cursor = state.nextCursor;
    if (cursor == null || state.isLoading) return;

    state = TrailListState(
      trails: state.trails,
      isLoading: true,
      nextCursor: cursor,
    );

    try {
      final TrailPage page = await _api.list(cursor: cursor);
      if (!ref.mounted) return;

      state = TrailListState(
        trails: <TrailSummary>[...state.trails, ...page.trails],
        nextCursor: page.nextCursor,
      );
    } on AppFailure catch (failure) {
      if (!ref.mounted) return;
      state = TrailListState(
        trails: state.trails,
        failure: failure,
        nextCursor: cursor,
      );
    }
  }
}

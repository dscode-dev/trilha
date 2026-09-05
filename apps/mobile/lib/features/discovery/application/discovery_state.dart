import 'package:equatable/equatable.dart';

import '../../../core/errors/app_failure.dart';
import '../domain/route_candidate.dart';

/// Where the user is in discovering places along a route (§63).
///
/// Deliberately separate from `RoutingState`. The two answer different questions and
/// fail independently: a route can be perfectly good while discovery is unavailable,
/// and folding them together would make one screen state claim both things at once.
///
/// [DiscoveryEmpty] is a distinct state rather than a success with no rows, because
/// the two need different words on screen — "nothing along this route" is an answer,
/// not an absence of one (§52).
sealed class DiscoveryState extends Equatable {
  const DiscoveryState();

  @override
  List<Object?> get props => <Object?>[];
}

/// No route yet, so nothing to discover along (§62).
final class DiscoveryIdle extends DiscoveryState {
  const DiscoveryIdle();
}

final class DiscoveryLoading extends DiscoveryState {
  const DiscoveryLoading({this.categories = const <String>[]});

  /// Kept so the filter chips stay selected while a request is in flight.
  final List<String> categories;

  @override
  List<Object?> get props => <Object?>[categories];
}

final class DiscoverySuccess extends DiscoveryState {
  const DiscoverySuccess({
    required this.candidates,
    required this.policyVersion,
    this.categories = const <String>[],
    this.selectedPlaceId,
  });

  final List<RouteCandidate> candidates;
  final String policyVersion;
  final List<String> categories;

  /// Which candidate the map and the list are both highlighting (§57).
  final String? selectedPlaceId;

  DiscoverySuccess withSelection(String? placeId) => DiscoverySuccess(
    candidates: candidates,
    policyVersion: policyVersion,
    categories: categories,
    selectedPlaceId: placeId,
  );

  @override
  List<Object?> get props => <Object?>[
    candidates,
    policyVersion,
    categories,
    selectedPlaceId,
  ];
}

/// A successful request that found nothing (§52).
final class DiscoveryEmpty extends DiscoveryState {
  const DiscoveryEmpty({this.categories = const <String>[]});

  final List<String> categories;

  @override
  List<Object?> get props => <Object?>[categories];
}

final class DiscoveryFailure extends DiscoveryState {
  const DiscoveryFailure({
    required this.failure,
    this.categories = const <String>[],
  });

  final AppFailure failure;
  final List<String> categories;

  @override
  List<Object?> get props => <Object?>[failure, categories];
}

extension DiscoveryStateX on DiscoveryState {
  bool get isLoading => this is DiscoveryLoading;

  List<RouteCandidate> get candidates => switch (this) {
    DiscoverySuccess(:final List<RouteCandidate> candidates) => candidates,
    _ => const <RouteCandidate>[],
  };

  String? get selectedPlaceId => switch (this) {
    DiscoverySuccess(:final String? selectedPlaceId) => selectedPlaceId,
    _ => null,
  };

  AppFailure? get failureOrNull => switch (this) {
    DiscoveryFailure(:final AppFailure failure) => failure,
    _ => null,
  };

  /// The active category filter, which survives every state transition so the chips
  /// never reset under the user mid-request.
  List<String> get categories => switch (this) {
    DiscoveryLoading(:final List<String> categories) => categories,
    DiscoverySuccess(:final List<String> categories) => categories,
    DiscoveryEmpty(:final List<String> categories) => categories,
    DiscoveryFailure(:final List<String> categories) => categories,
    DiscoveryIdle() => const <String>[],
  };

  /// True once discovery has anything to show or say — the sheet's visibility.
  bool get isActive => this is! DiscoveryIdle;
}

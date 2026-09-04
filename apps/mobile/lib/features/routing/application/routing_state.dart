import 'package:equatable/equatable.dart';

import '../../../core/errors/app_failure.dart';
import '../domain/route.dart';

/// Where the user is in building a route (§42).
///
/// A sealed hierarchy rather than a bag of booleans. `isLoading`, `hasRoute` and
/// `hasError` as separate flags admit combinations that cannot happen — loading and
/// failed at once, a route present while an error shows — and every screen would then
/// have to decide which flag wins. Here the impossible states simply cannot be
/// written down.
sealed class RoutingState extends Equatable {
  const RoutingState({this.origin, this.destination});

  /// Selections survive across states: a failed calculation must not lose them.
  final RouteEndpoint? origin;
  final RouteEndpoint? destination;

  bool get hasBothEndpoints => origin != null && destination != null;

  @override
  List<Object?> get props => <Object?>[origin, destination];
}

/// Nothing chosen yet.
final class RoutingIdle extends RoutingState {
  const RoutingIdle({super.origin, super.destination});
}

/// One endpoint chosen; the other still needed.
final class RoutingSelecting extends RoutingState {
  const RoutingSelecting({super.origin, super.destination});
}

/// Both endpoints chosen and nothing calculated yet.
///
/// Distinct from [RoutingIdle] because it is what enables the calculate action —
/// nothing is requested until the user asks (§35).
final class RoutingReady extends RoutingState {
  const RoutingReady({
    required RouteEndpoint super.origin,
    required RouteEndpoint super.destination,
  });
}

final class RoutingLoading extends RoutingState {
  const RoutingLoading({
    required RouteEndpoint super.origin,
    required RouteEndpoint super.destination,
  });
}

final class RoutingSuccess extends RoutingState {
  const RoutingSuccess({
    required this.route,
    required RouteEndpoint super.origin,
    required RouteEndpoint super.destination,
  });

  final TrilhaRoute route;

  @override
  List<Object?> get props => <Object?>[...super.props, route];
}

final class RoutingFailure extends RoutingState {
  const RoutingFailure({
    required this.failure,
    required RouteEndpoint super.origin,
    required RouteEndpoint super.destination,
  });

  final AppFailure failure;

  @override
  List<Object?> get props => <Object?>[...super.props, failure];
}

extension RoutingStateX on RoutingState {
  bool get isLoading => this is RoutingLoading;
  bool get canCalculate => this is RoutingReady || this is RoutingFailure;

  TrilhaRoute? get routeOrNull => switch (this) {
    RoutingSuccess(:final TrilhaRoute route) => route,
    _ => null,
  };

  AppFailure? get failureOrNull => switch (this) {
    RoutingFailure(:final AppFailure failure) => failure,
    _ => null,
  };

  /// True once anything has been selected, so the UI knows to show a route panel.
  bool get isActive => origin != null || destination != null;
}

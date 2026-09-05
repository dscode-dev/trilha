import 'package:equatable/equatable.dart';

import '../../../core/errors/app_failure.dart';
import '../domain/trail.dart';

/// The Trail Builder's state (§58).
///
/// One shape rather than a sealed hierarchy, because unlike routing or discovery the
/// interesting states here overlap: a trail can be loaded *and* saving, or loaded and
/// showing a failure from the last attempt while still perfectly usable. Splitting
/// those into cases would mean carrying the trail through every one of them.
class TrailState extends Equatable {
  const TrailState({
    this.trail,
    this.isLoading = false,
    this.isMutating = false,
    this.failure,
    this.conflictDetected = false,
  });

  /// The trail being built. Null before one is created or opened.
  final Trail? trail;

  /// A read is in flight — opening a saved trail.
  final bool isLoading;

  /// A composition change is in flight. Mutations also re-route, so this is what
  /// disables the controls that would queue a second provider call.
  final bool isMutating;

  final AppFailure? failure;

  /// Someone else's write landed first, so the local view was stale (§78).
  ///
  /// Distinct from a plain failure because the remedy is different: the user is not
  /// asked to retry, they are told the trail was reloaded.
  final bool conflictDetected;

  bool get hasTrail => trail != null;

  /// Composition changes are refused while one is in flight, so a double-tap cannot
  /// spend two routing calls (§55).
  bool get canMutate => trail != null && !isMutating;

  TrailState copyWith({
    Trail? trail,
    bool? isLoading,
    bool? isMutating,
    AppFailure? failure,
    bool clearFailure = false,
    bool? conflictDetected,
  }) => TrailState(
    trail: trail ?? this.trail,
    isLoading: isLoading ?? this.isLoading,
    isMutating: isMutating ?? this.isMutating,
    failure: clearFailure ? null : (failure ?? this.failure),
    conflictDetected: conflictDetected ?? this.conflictDetected,
  );

  /// Clears the trail entirely — closing the builder.
  TrailState cleared() => const TrailState();

  @override
  List<Object?> get props => <Object?>[
    trail,
    isLoading,
    isMutating,
    failure,
    conflictDetected,
  ];
}

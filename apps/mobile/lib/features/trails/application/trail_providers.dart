import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/bootstrap/providers.dart';
import '../../../core/logging/app_logger.dart';
import '../data/trails_api.dart';
import 'trail_controller.dart';
import 'trail_list_controller.dart';
import 'trail_state.dart';

/// Composition for the trails feature (§58).
///
/// Trails depends on routing and discovery for what the user is looking at, and on
/// neither for what it stores: the backend is the source of truth, and the builder
/// holds no composition the server has not accepted.

/// Overridden in tests with a fake implementation of [TrailEndpoints].
final Provider<TrailEndpoints> trailsApiProvider = Provider<TrailEndpoints>(
  (ref) => TrailsApi(ref.watch(apiClientProvider)),
  name: 'trailsApi',
);

final Provider<AppLogger> trailLoggerProvider = Provider<AppLogger>(
  (ref) => ref.watch(appLoggerProvider).child('trails'),
  name: 'trailLogger',
);

final NotifierProvider<TrailController, TrailState> trailControllerProvider =
    NotifierProvider<TrailController, TrailState>(
      TrailController.new,
      name: 'trailController',
    );

final NotifierProvider<TrailListController, TrailListState>
trailListControllerProvider =
    NotifierProvider<TrailListController, TrailListState>(
      TrailListController.new,
      name: 'trailListController',
    );

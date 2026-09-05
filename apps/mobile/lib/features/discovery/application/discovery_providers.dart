import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/bootstrap/providers.dart';
import '../../../core/logging/app_logger.dart';
import '../data/discovery_api.dart';
import 'discovery_controller.dart';
import 'discovery_state.dart';

/// Composition for the discovery feature (§66).
///
/// Discovery depends on routing for the route it searches along, and on nothing else.
/// It does not import Mapbox, and it does not reach into the Places controller: the
/// candidates it shows are its own, and mixing them into the map's Place list would
/// make "what did the user contribute" and "what did the ranking suggest"
/// indistinguishable.

/// Overridden in tests with a fake implementation of [DiscoveryEndpoints].
final Provider<DiscoveryEndpoints> discoveryApiProvider =
    Provider<DiscoveryEndpoints>(
      (ref) => DiscoveryApi(ref.watch(apiClientProvider)),
      name: 'discoveryApi',
    );

final Provider<AppLogger> discoveryLoggerProvider = Provider<AppLogger>(
  (ref) => ref.watch(appLoggerProvider).child('discovery'),
  name: 'discoveryLogger',
);

final NotifierProvider<DiscoveryController, DiscoveryState>
discoveryControllerProvider =
    NotifierProvider<DiscoveryController, DiscoveryState>(
      DiscoveryController.new,
      name: 'discoveryController',
    );

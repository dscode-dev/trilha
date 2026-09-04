import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/bootstrap/providers.dart';
import '../../../core/logging/app_logger.dart';
import '../data/routing_api.dart';
import 'routing_controller.dart';
import 'routing_state.dart';

/// Composition for the routing feature.
///
/// `routing` depends on `places` for search and on `map` for the device position, and
/// on neither for anything else. Nothing here imports Mapbox: the SDK belongs to the
/// presentation layer (§46).

/// Overridden in tests with a fake implementation of [RoutingEndpoints].
final Provider<RoutingEndpoints> routingApiProvider =
    Provider<RoutingEndpoints>(
      (ref) => RoutingApi(ref.watch(apiClientProvider)),
      name: 'routingApi',
    );

final Provider<AppLogger> routingLoggerProvider = Provider<AppLogger>(
  (ref) => ref.watch(appLoggerProvider).child('routing'),
  name: 'routingLogger',
);

final NotifierProvider<RoutingController, RoutingState>
routingControllerProvider = NotifierProvider<RoutingController, RoutingState>(
  RoutingController.new,
  name: 'routingController',
);

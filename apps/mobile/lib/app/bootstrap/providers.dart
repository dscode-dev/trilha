import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/logging/app_logger.dart';
import '../../core/networking/api_client.dart';
import '../../core/observability/error_reporter.dart';
import '../config/app_config.dart';

/// Composition root providers (ADR-0005).
///
/// Riverpod is used here for dependency composition and lifecycle — not as an
/// architecture. These providers hold infrastructure only; business rules will live
/// in each feature's own layers, never inside a provider body.

/// Overridden in [bootstrap]; reading it without an override is a programming error.
final Provider<AppConfig> appConfigProvider = Provider<AppConfig>(
  (ref) => throw UnimplementedError(
    'appConfigProvider must be overridden in ProviderScope',
  ),
  name: 'appConfig',
);

final Provider<AppLogger> appLoggerProvider = Provider<AppLogger>(
  (ref) => throw UnimplementedError(
    'appLoggerProvider must be overridden in ProviderScope',
  ),
  name: 'appLogger',
);

final Provider<ErrorReporter> errorReporterProvider = Provider<ErrorReporter>(
  (ref) => throw UnimplementedError(
    'errorReporterProvider must be overridden in ProviderScope',
  ),
  name: 'errorReporter',
);

/// The shared HTTP client. Disposed with the scope that owns it, so its sockets do
/// not outlive the app (§16: providers respect lifecycle and ownership).
final Provider<ApiClient> apiClientProvider = Provider<ApiClient>((ref) {
  final ApiClient client = ApiClient(
    config: ref.watch(appConfigProvider),
    logger: ref.watch(appLoggerProvider),
  );
  ref.onDispose(client.close);
  return client;
}, name: 'apiClient');

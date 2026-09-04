import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/logging/app_logger.dart';
import '../../core/networking/api_client.dart';
import '../../core/observability/error_reporter.dart';
import '../../features/auth/application/auth_providers.dart';
import '../../features/auth/data/auth_interceptor.dart';
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
///
/// Authentication is attached here, in the composition root, rather than inside
/// `core/networking` — the transport stays unaware of the auth feature, and the one
/// place that knows about both is the place whose job that is.
final Provider<ApiClient> apiClientProvider = Provider<ApiClient>((ref) {
  final AppConfig config = ref.watch(appConfigProvider);
  final ApiClient client = ApiClient(
    config: config,
    logger: ref.watch(appLoggerProvider),
  );

  /// Replays a request after a refresh. A separate Dio so the replay cannot
  /// re-enter [AuthInterceptor] and start a second refresh cycle.
  final Dio retryClient = Dio(client.raw.options);

  client.raw.interceptors.add(
    AuthInterceptor(
      // Resolved lazily, per request: reading the controller here at construction
      // time would close a provider cycle, since the controller is built on this
      // very client.
      readAccessToken: () =>
          ref.read(authControllerProvider.notifier).currentAccessToken(),
      // A 401 means the server rejected a token the client still considered valid,
      // so expiry is not a useful signal. The rejected token is passed along so a
      // burst of 401s collapses onto one rotation rather than one each.
      refreshAccessToken: (String? staleToken) => ref
          .read(authControllerProvider.notifier)
          .forceRefresh(staleToken: staleToken),
      retryClient: retryClient,
    ),
  );

  ref.onDispose(() {
    retryClient.close(force: true);
    client.close();
  });
  return client;
}, name: 'apiClient');

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/logging/app_logger.dart';
import '../../core/observability/error_reporter.dart';
import '../config/app_config.dart';
import '../config/app_environment.dart';
import 'providers.dart';

/// Starts the application with error handling installed before anything renders (§20).
///
/// Three failure channels are covered:
///   1. Flutter framework errors (`FlutterError.onError`);
///   2. errors from the platform layer that never reach a Dart zone
///      (`PlatformDispatcher.instance.onError`);
///   3. failures thrown while bootstrapping itself.
///
/// Nothing is swallowed: every path reaches the [ErrorReporter].
Future<void> bootstrap({required Widget Function() builder}) async {
  const AppLogger logger = AppLogger(name: 'trilha');
  const ErrorReporter reporter = LoggingErrorReporter(logger);

  // Must run inside the same zone as runApp.
  WidgetsFlutterBinding.ensureInitialized();

  FlutterError.onError = (FlutterErrorDetails details) {
    reporter.reportError(
      details.exception,
      details.stack ?? StackTrace.current,
      context: details.context?.toString() ?? 'flutter',
      fatal: false,
    );
  };

  PlatformDispatcher.instance.onError = (Object error, StackTrace stackTrace) {
    reporter.reportError(error, stackTrace, context: 'platform', fatal: true);
    // Handled: returning true stops the engine from terminating the isolate.
    return true;
  };

  try {
    final AppEnvironment environment = AppEnvironment.resolve();
    final AppConfig config = AppConfig.forEnvironment(environment);

    logger.info(
      'Starting Trilha',
      context: {
        'environment': environment.name,
        'apiBaseUrl': config.apiBaseUrl,
      },
    );

    runApp(
      ProviderScope(
        overrides: [
          // Configuration is resolved once, at the composition root, and injected —
          // no widget reads build-time defines directly.
          appConfigProvider.overrideWithValue(config),
          appLoggerProvider.overrideWithValue(logger),
          errorReporterProvider.overrideWithValue(reporter),
        ],
        child: builder(),
      ),
    );
  } catch (error, stackTrace) {
    reporter.reportError(error, stackTrace, context: 'bootstrap', fatal: true);
    rethrow;
  }
}

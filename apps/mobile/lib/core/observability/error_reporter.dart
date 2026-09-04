import 'package:flutter/foundation.dart';

import '../logging/app_logger.dart';

/// Sink for unhandled failures (§14, §20).
///
/// Bootstrap routes framework and zone errors here. Keeping the seam explicit means
/// a crash reporter (Sentry) can be attached in a later PR by adding one
/// implementation — no feature code references a vendor.
abstract interface class ErrorReporter {
  /// Records a failure that escaped normal handling.
  void reportError(
    Object error,
    StackTrace stackTrace, {
    String? context,
    bool fatal,
  });
}

/// Default reporter: writes the failure to the structured log.
///
/// This is a real destination, not a placeholder — during development the error is
/// visible in DevTools and in `flutter logs`, and in release it still reaches the
/// platform log rather than vanishing (§20: never swallow exceptions silently).
class LoggingErrorReporter implements ErrorReporter {
  const LoggingErrorReporter(this._logger);

  final AppLogger _logger;

  @override
  void reportError(
    Object error,
    StackTrace stackTrace, {
    String? context,
    bool fatal = false,
  }) {
    _logger.error(
      context == null ? 'Unhandled error' : 'Unhandled error in $context',
      error: error,
      stackTrace: stackTrace,
      context: {'fatal': fatal, 'kind': error.runtimeType.toString()},
    );

    // Surfacing to the platform keeps the failure visible to `flutter run` and to
    // native crash tooling.
    FlutterError.presentError(
      FlutterErrorDetails(
        exception: error,
        stack: stackTrace,
        library: 'trilha',
      ),
    );
  }
}

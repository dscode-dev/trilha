import 'dart:developer' as developer;

import 'package:flutter/foundation.dart';

/// Severity ordering used to filter output.
enum LogLevel {
  debug(500, 'DEBUG'),
  info(800, 'INFO'),
  warning(900, 'WARN'),
  error(1000, 'ERROR');

  const LogLevel(this.value, this.label);

  final int value;
  final String label;
}

/// Structured application logging (§13 equivalent for the client).
///
/// `print` is never used: output goes through `dart:developer`, which DevTools and
/// the platform log readers understand. In release builds only warnings and errors
/// are emitted, so a shipped app does not narrate itself.
class AppLogger {
  const AppLogger({required this.name, LogLevel? minimumLevel})
    : _minimumLevel =
          minimumLevel ?? (kReleaseMode ? LogLevel.warning : LogLevel.debug);

  final String name;
  final LogLevel _minimumLevel;

  /// Keys whose values must never reach a log sink.
  static const Set<String> _redactedKeys = {
    'authorization',
    'password',
    'token',
    'accesstoken',
    'refreshtoken',
    'secret',
    'cookie',
    'apikey',
  };

  AppLogger child(String suffix) =>
      AppLogger(name: '$name.$suffix', minimumLevel: _minimumLevel);

  void debug(String message, {Map<String, Object?>? context}) =>
      _log(LogLevel.debug, message, context: context);

  void info(String message, {Map<String, Object?>? context}) =>
      _log(LogLevel.info, message, context: context);

  void warning(
    String message, {
    Map<String, Object?>? context,
    Object? error,
  }) => _log(LogLevel.warning, message, context: context, error: error);

  void error(
    String message, {
    Object? error,
    StackTrace? stackTrace,
    Map<String, Object?>? context,
  }) => _log(
    LogLevel.error,
    message,
    context: context,
    error: error,
    stackTrace: stackTrace,
  );

  void _log(
    LogLevel level,
    String message, {
    Map<String, Object?>? context,
    Object? error,
    StackTrace? stackTrace,
  }) {
    if (level.value < _minimumLevel.value) return;

    final String suffix = context == null || context.isEmpty
        ? ''
        : ' ${redact(context)}';

    developer.log(
      '[${level.label}] $message$suffix',
      name: name,
      level: level.value,
      error: error,
      stackTrace: stackTrace,
    );
  }

  /// Replaces the value of any sensitive key, at any depth, with a marker.
  @visibleForTesting
  static Map<String, Object?> redact(Map<String, Object?> input) {
    return input.map((key, value) {
      if (_redactedKeys.contains(key.toLowerCase())) {
        return MapEntry(key, '[REDACTED]');
      }
      if (value is Map<String, Object?>) {
        return MapEntry(key, redact(value));
      }
      return MapEntry(key, value);
    });
  }
}

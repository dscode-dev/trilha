import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/core/logging/app_logger.dart';

void main() {
  group('AppLogger.redact', () {
    test('masks credential-bearing keys regardless of case', () {
      final Map<String, Object?> redacted = AppLogger.redact(<String, Object?>{
        'Authorization': 'Bearer abc123',
        'PASSWORD': 'hunter2',
        'accessToken': 'tok',
        'refreshToken': 'tok2',
        'secret': 's',
        'Cookie': 'sid=1',
      });

      for (final Object? value in redacted.values) {
        expect(value, '[REDACTED]');
      }
    });

    test('preserves values that are safe to log', () {
      final Map<String, Object?> redacted = AppLogger.redact(<String, Object?>{
        'requestId': 'trace-1',
        'status': 200,
        'path': '/api/v1/health',
      });

      expect(redacted['requestId'], 'trace-1');
      expect(redacted['status'], 200);
      expect(redacted['path'], '/api/v1/health');
    });

    test('redacts nested structures', () {
      final Map<String, Object?> redacted = AppLogger.redact(<String, Object?>{
        'headers': <String, Object?>{
          'authorization': 'Bearer abc',
          'accept': 'application/json',
        },
      });

      final Map<String, Object?> headers =
          redacted['headers']! as Map<String, Object?>;
      expect(headers['authorization'], '[REDACTED]');
      expect(headers['accept'], 'application/json');
    });

    test('leaves an empty map untouched', () {
      expect(AppLogger.redact(<String, Object?>{}), isEmpty);
    });
  });

  group('AppLogger', () {
    test('child loggers namespace under the parent', () {
      expect(const AppLogger(name: 'trilha').child('http').name, 'trilha.http');
    });

    test('log levels are ordered by severity', () {
      expect(LogLevel.debug.value, lessThan(LogLevel.info.value));
      expect(LogLevel.info.value, lessThan(LogLevel.warning.value));
      expect(LogLevel.warning.value, lessThan(LogLevel.error.value));
    });
  });
}

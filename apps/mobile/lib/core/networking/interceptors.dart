import 'dart:math';

import 'package:dio/dio.dart';

import '../logging/app_logger.dart';

/// Header used to correlate a client request with the server's logs (§12).
const String kRequestIdHeader = 'x-request-id';

/// Stamps every outbound request with a correlation id.
///
/// The API accepts and echoes this header, so a client-side failure report can be
/// matched to the exact server log line that recorded it.
class RequestIdInterceptor extends Interceptor {
  RequestIdInterceptor({Random? random}) : _random = random ?? Random();

  final Random _random;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    options.headers.putIfAbsent(kRequestIdHeader, _generateId);
    handler.next(options);
  }

  /// RFC 4122 version 4 identifier, generated without pulling in a uuid package
  /// for a single call site.
  String _generateId() {
    final List<int> bytes = List<int>.generate(16, (_) => _random.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx

    final String hex = bytes
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join();

    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}'
        '-${hex.substring(16, 20)}-${hex.substring(20)}';
  }
}

/// Logs request/response metadata during development only (§18).
///
/// Bodies and credential headers are never logged: a debug build still runs on a
/// real device, and a token in a log is a leaked token.
class LoggingInterceptor extends Interceptor {
  const LoggingInterceptor({required this.logger, required this.enabled});

  final AppLogger logger;

  /// Off in release builds: request metadata is developer diagnostics, not telemetry.
  final bool enabled;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    if (enabled) {
      logger.debug(
        '→ ${options.method} ${options.uri.path}',
        context: {'requestId': options.headers[kRequestIdHeader]},
      );
    }
    handler.next(options);
  }

  @override
  void onResponse(
    Response<dynamic> response,
    ResponseInterceptorHandler handler,
  ) {
    if (enabled) {
      logger.debug(
        '← ${response.statusCode} ${response.requestOptions.uri.path}',
        context: {'requestId': response.headers.value(kRequestIdHeader)},
      );
    }
    handler.next(response);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    if (enabled) {
      logger.warning(
        '✕ ${err.requestOptions.method} ${err.requestOptions.uri.path}',
        context: {
          'type': err.type.name,
          'status': err.response?.statusCode,
          'requestId': err.response?.headers.value(kRequestIdHeader),
        },
      );
    }
    handler.next(err);
  }
}

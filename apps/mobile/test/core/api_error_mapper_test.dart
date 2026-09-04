import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/core/errors/app_exception.dart';
import 'package:trilha_mobile/core/networking/api_error_mapper.dart';

RequestOptions _options() => RequestOptions(path: '/health');

DioException _withResponse({
  required int statusCode,
  Object? data,
  Map<String, List<String>>? headers,
}) {
  return DioException(
    requestOptions: _options(),
    type: DioExceptionType.badResponse,
    response: Response<Object?>(
      requestOptions: _options(),
      statusCode: statusCode,
      data: data,
      headers: Headers.fromMap(headers ?? <String, List<String>>{}),
    ),
  );
}

void main() {
  group('ApiErrorMapper transport failures', () {
    test('every DioExceptionType maps to a defined kind', () {
      // Guards against a dio upgrade silently adding an unhandled case.
      for (final DioExceptionType type in DioExceptionType.values) {
        final ApiException mapped = ApiErrorMapper.map(
          DioException(requestOptions: _options(), type: type),
        );
        expect(mapped.message, isNotEmpty, reason: 'no message for $type');
      }
    });

    test('timeouts are classified as retryable timeouts', () {
      for (final DioExceptionType type in <DioExceptionType>[
        DioExceptionType.connectionTimeout,
        DioExceptionType.sendTimeout,
        DioExceptionType.receiveTimeout,
        DioExceptionType.transformTimeout,
      ]) {
        final ApiException mapped = ApiErrorMapper.map(
          DioException(requestOptions: _options(), type: type),
        );
        expect(mapped.kind, AppErrorKind.timeout, reason: '$type');
        expect(mapped.isRetryable, isTrue);
      }
    });

    test('connection errors are retryable network failures', () {
      final ApiException mapped = ApiErrorMapper.map(
        DioException(
          requestOptions: _options(),
          type: DioExceptionType.connectionError,
        ),
      );

      expect(mapped.kind, AppErrorKind.network);
      expect(mapped.isRetryable, isTrue);
    });

    test('cancellation is not retryable', () {
      final ApiException mapped = ApiErrorMapper.map(
        DioException(requestOptions: _options(), type: DioExceptionType.cancel),
      );

      expect(mapped.kind, AppErrorKind.cancelled);
      expect(mapped.isRetryable, isFalse);
    });
  });

  group('ApiErrorMapper HTTP statuses', () {
    test('maps status codes to the right kind', () {
      final Map<int, AppErrorKind> expectations = <int, AppErrorKind>{
        400: AppErrorKind.badRequest,
        401: AppErrorKind.unauthorized,
        403: AppErrorKind.unauthorized,
        404: AppErrorKind.notFound,
        409: AppErrorKind.badRequest,
        500: AppErrorKind.server,
        503: AppErrorKind.server,
      };

      expectations.forEach((int status, AppErrorKind kind) {
        expect(
          ApiErrorMapper.map(_withResponse(statusCode: status)).kind,
          kind,
          reason: '$status',
        );
      });
    });

    test('4xx is not retryable, 5xx is', () {
      expect(
        ApiErrorMapper.map(_withResponse(statusCode: 400)).isRetryable,
        isFalse,
      );
      expect(
        ApiErrorMapper.map(_withResponse(statusCode: 503)).isRetryable,
        isTrue,
      );
    });
  });

  group('ApiErrorMapper server error envelope', () {
    test('reads code, message and requestId from the API contract', () {
      final ApiException mapped = ApiErrorMapper.map(
        _withResponse(
          statusCode: 404,
          data: <String, Object?>{
            'error': <String, Object?>{
              'code': 'NOT_FOUND',
              'message': 'Route not found',
              'requestId': 'trace-1',
            },
          },
        ),
      );

      expect(mapped.code, 'NOT_FOUND');
      expect(mapped.message, 'Route not found');
      expect(mapped.requestId, 'trace-1');
      expect(mapped.statusCode, 404);
    });

    test(
      'falls back to a safe default when the body is not the expected envelope',
      () {
        for (final Object? body in <Object?>[
          null,
          'plain text',
          <String, Object?>{},
          <String, Object?>{'error': 'not an object'},
          <String, Object?>{'error': <String, Object?>{}},
        ]) {
          final ApiException mapped = ApiErrorMapper.map(
            _withResponse(statusCode: 500, data: body),
          );

          expect(mapped.message, isNotEmpty);
          expect(mapped.kind, AppErrorKind.server);
        }
      },
    );

    test('falls back to the x-request-id header when the body omits it', () {
      final ApiException mapped = ApiErrorMapper.map(
        _withResponse(
          statusCode: 500,
          headers: <String, List<String>>{
            'x-request-id': <String>['header-trace'],
          },
        ),
      );

      expect(mapped.requestId, 'header-trace');
    });
  });
}

import 'package:dio/dio.dart';

import '../errors/app_exception.dart';

/// Translates transport-level failures into the app's typed error model (§18, §20).
///
/// This is the only place that knows Dio exists. Features depend on [AppException],
/// so replacing the HTTP client would not reach beyond this file.
abstract final class ApiErrorMapper {
  const ApiErrorMapper._();

  static ApiException map(DioException exception) {
    final Response<dynamic>? response = exception.response;
    final String? requestId = _requestIdOf(response);

    switch (exception.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.transformTimeout:
        return ApiException(
          kind: AppErrorKind.timeout,
          message:
              'The request took too long. Check your connection and try again.',
          debugDetail: exception.message,
          requestId: requestId,
          cause: exception,
        );

      case DioExceptionType.connectionError:
      case DioExceptionType.unknown:
        return ApiException(
          kind: AppErrorKind.network,
          message: 'Cannot reach Trilha right now. Check your connection and try again.',
          debugDetail: exception.message,
          requestId: requestId,
          cause: exception,
        );

      case DioExceptionType.cancel:
        return ApiException(
          kind: AppErrorKind.cancelled,
          message: 'Request cancelled.',
          requestId: requestId,
          cause: exception,
        );

      case DioExceptionType.badCertificate:
        return ApiException(
          kind: AppErrorKind.network,
          message: 'The secure connection could not be verified.',
          debugDetail: exception.message,
          requestId: requestId,
          cause: exception,
        );

      case DioExceptionType.badResponse:
        return _mapBadResponse(exception, response, requestId);
    }
  }

  static ApiException _mapBadResponse(
    DioException exception,
    Response<dynamic>? response,
    String? requestId,
  ) {
    final int status = response?.statusCode ?? 0;
    final _ServerError? serverError = _parseServerError(response?.data);

    return ApiException(
      kind: _kindForStatus(status),
      // Prefer the API's own message; it is written for clients and already
      // scrubbed of internals by the server's error filter.
      message: serverError?.message ?? _defaultMessageForStatus(status),
      statusCode: status,
      code: serverError?.code,
      debugDetail: exception.message,
      requestId: serverError?.requestId ?? requestId,
      cause: exception,
    );
  }

  static AppErrorKind _kindForStatus(int status) {
    if (status == 401 || status == 403) return AppErrorKind.unauthorized;
    if (status == 404) return AppErrorKind.notFound;
    if (status >= 500) return AppErrorKind.server;
    if (status >= 400) return AppErrorKind.badRequest;
    return AppErrorKind.unknown;
  }

  static String _defaultMessageForStatus(int status) {
    if (status == 401 || status == 403) {
      return 'You are not allowed to do that.';
    }
    if (status == 404) {
      return 'That could not be found.';
    }
    if (status >= 500) {
      return 'Trilha is having trouble right now. Please try again shortly.';
    }
    return 'That request could not be completed.';
  }

  /// Reads the `{ error: { code, message, requestId } }` envelope the API guarantees.
  static _ServerError? _parseServerError(Object? data) {
    if (data is! Map) return null;

    final Object? error = data['error'];
    if (error is! Map) return null;

    final Object? message = error['message'];
    final Object? code = error['code'];
    final Object? requestId = error['requestId'];

    return _ServerError(
      message: message is String && message.isNotEmpty ? message : null,
      code: code is String ? code : null,
      requestId: requestId is String ? requestId : null,
    );
  }

  static String? _requestIdOf(Response<dynamic>? response) =>
      response?.headers.value('x-request-id');
}

class _ServerError {
  const _ServerError({this.message, this.code, this.requestId});

  final String? message;
  final String? code;
  final String? requestId;
}

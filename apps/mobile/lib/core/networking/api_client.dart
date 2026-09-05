import 'package:dio/dio.dart';

import '../../app/config/app_config.dart';
import '../errors/app_exception.dart';
import '../logging/app_logger.dart';
import 'api_error_mapper.dart';
import 'interceptors.dart';

/// The app's HTTP entry point (§18).
///
/// Every call funnels through here so that base URL, timeouts, correlation ids and
/// error translation are applied uniformly. Callers receive decoded data or an
/// [AppException] — never a `DioException`, and never a raw status code to inspect.
///
/// Authentication is deliberately absent: it arrives with PR-01.
class ApiClient {
  ApiClient({required AppConfig config, required AppLogger logger, Dio? dio})
    : _dio = dio ?? Dio() {
    _dio.options = _dio.options.copyWith(
      baseUrl: config.apiBaseUrl,
      connectTimeout: config.connectTimeout,
      receiveTimeout: config.receiveTimeout,
      sendTimeout: config.connectTimeout,
      contentType: Headers.jsonContentType,
      responseType: ResponseType.json,
      headers: <String, String>{'accept': Headers.jsonContentType},
      // Non-2xx is an error path, not a value to be inspected by callers.
      validateStatus: (status) =>
          status != null && status >= 200 && status < 300,
    );

    _dio.interceptors.addAll([
      RequestIdInterceptor(),
      LoggingInterceptor(
        logger: logger.child('http'),
        enabled: !config.environment.isProduction,
      ),
    ]);
  }

  final Dio _dio;

  /// Exposed so future features can register auth or retry interceptors without
  /// reaching for a second Dio instance.
  Dio get raw => _dio;

  Future<T> get<T>(
    String path, {
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
  }) => _send<T>(
    () => _dio.get<T>(
      path,
      queryParameters: queryParameters,
      options: options,
      cancelToken: cancelToken,
    ),
  );

  Future<T> post<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
  }) => _send<T>(
    () => _dio.post<T>(
      path,
      data: data,
      queryParameters: queryParameters,
      options: options,
      cancelToken: cancelToken,
    ),
  );

  Future<T> patch<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
  }) => _send<T>(
    () => _dio.patch<T>(
      path,
      data: data,
      queryParameters: queryParameters,
      options: options,
      cancelToken: cancelToken,
    ),
  );

  Future<T> put<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
  }) => _send<T>(
    () => _dio.put<T>(
      path,
      data: data,
      queryParameters: queryParameters,
      options: options,
      cancelToken: cancelToken,
    ),
  );

  /// DELETE with an optional body.
  ///
  /// A body on DELETE is unusual but deliberate here: trail mutations carry an
  /// `expectedRevision`, and putting it in a query string would make a write's
  /// concurrency token look like a filter.
  Future<T> delete<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
  }) => _send<T>(
    () => _dio.delete<T>(
      path,
      data: data,
      queryParameters: queryParameters,
      options: options,
      cancelToken: cancelToken,
    ),
  );

  /// Runs [request], converting every failure into an [AppException].
  Future<T> _send<T>(Future<Response<T>> Function() request) async {
    try {
      final Response<T> response = await request();
      final T? data = response.data;

      if (data == null) {
        // 204 and 205 carry no body by definition; a caller expecting void is
        // satisfied, and anything else is a genuine contract violation.
        if (response.statusCode == 204 || response.statusCode == 205) {
          return null as T;
        }
        throw ApiException(
          kind: AppErrorKind.server,
          message: 'Trilha returned an empty response.',
          statusCode: response.statusCode,
          requestId: response.headers.value(kRequestIdHeader),
        );
      }
      return data;
    } on DioException catch (exception) {
      throw ApiErrorMapper.map(exception);
    }
  }

  void close({bool force = false}) => _dio.close(force: force);
}

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
    CancelToken? cancelToken,
  }) => _send<T>(
    () => _dio.get<T>(
      path,
      queryParameters: queryParameters,
      cancelToken: cancelToken,
    ),
  );

  Future<T> post<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    CancelToken? cancelToken,
  }) => _send<T>(
    () => _dio.post<T>(
      path,
      data: data,
      queryParameters: queryParameters,
      cancelToken: cancelToken,
    ),
  );

  /// Runs [request], converting every failure into an [AppException].
  Future<T> _send<T>(Future<Response<T>> Function() request) async {
    try {
      final Response<T> response = await request();
      final T? data = response.data;

      if (data == null) {
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

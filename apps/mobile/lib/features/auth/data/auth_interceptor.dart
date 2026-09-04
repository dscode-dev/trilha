import 'package:dio/dio.dart';

/// Attaches the access token and retries once after a refresh (§38, §39).
///
/// The refresh itself is **not** performed here: it is delegated to the auth
/// controller, which collapses concurrent callers onto one rotation. That matters
/// because the server issues single-use refresh tokens and treats a replay as
/// compromise — ten parallel 401s must produce one rotation, not ten.
class AuthInterceptor extends QueuedInterceptor {
  AuthInterceptor({
    required this.readAccessToken,
    required this.refreshAccessToken,
    required this.retryClient,
  });

  static const String _retriedFlag = 'trilha.auth.retried';

  /// Endpoints that must never carry a bearer token or trigger a refresh: sending
  /// one to the login route is meaningless, and refreshing in response to a failed
  /// refresh would loop.
  static const Set<String> _unauthenticatedPaths = <String>{
    '/auth/login',
    '/auth/register',
    '/auth/refresh',
  };

  /// Supplies the current access token, refreshing first if it is about to expire.
  final Future<String?> Function() readAccessToken;

  /// Recovers from a rejected token, given the token that was actually sent.
  ///
  /// Passing the stale value lets the controller answer "someone already rotated —
  /// here is the current token" instead of rotating again for every queued 401.
  final Future<String?> Function(String? staleToken) refreshAccessToken;

  /// Client used to replay the original request. Separate from the intercepted one
  /// so the replay cannot re-enter this interceptor.
  final Dio retryClient;

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    if (_isUnauthenticated(options) ||
        options.headers.containsKey('Authorization')) {
      handler.next(options);
      return;
    }

    final String? token = await readAccessToken();
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final RequestOptions request = err.requestOptions;

    final bool shouldRetry =
        err.response?.statusCode == 401 &&
        !_isUnauthenticated(request) &&
        request.extra[_retriedFlag] != true;

    if (!shouldRetry) {
      handler.next(err);
      return;
    }

    // One shared refresh, however many requests are waiting on it: the token that
    // was rejected identifies which rotation this request is waiting for.
    final String? sentToken = _bearerOf(request.headers['Authorization']);
    final String? token = await refreshAccessToken(sentToken);
    if (token == null) {
      // The session is gone; the controller has already cleared local state.
      handler.next(err);
      return;
    }

    // Marked before replay so a second 401 cannot start another round (§39).
    request.extra[_retriedFlag] = true;
    request.headers['Authorization'] = 'Bearer $token';

    try {
      final Response<dynamic> response = await retryClient.fetch<dynamic>(
        request,
      );
      handler.resolve(response);
    } on DioException catch (retryError) {
      handler.next(retryError);
    }
  }

  bool _isUnauthenticated(RequestOptions options) =>
      _unauthenticatedPaths.any((String path) => options.path.endsWith(path));

  static String? _bearerOf(Object? header) {
    if (header is! String) return null;
    const String prefix = 'Bearer ';
    return header.startsWith(prefix) ? header.substring(prefix.length) : null;
  }
}

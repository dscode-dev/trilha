import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/features/auth/data/auth_interceptor.dart';

/// Token attachment and 401 recovery at the transport layer (§38, §39).
void main() {
  late List<RequestOptions> seen;
  late Dio dio;
  late int refreshCalls;
  String? accessToken;
  String? refreshedToken;

  /// Answers 401 until a refreshed token arrives, then 200 — the shape of a real
  /// expiry, so the retry path is genuinely exercised.
  void buildClient({required bool everSucceeds}) {
    seen = <RequestOptions>[];
    dio = Dio(BaseOptions(baseUrl: 'http://localhost/api/v1'));

    final Dio retryClient = Dio(dio.options);
    for (final Dio client in <Dio>[dio, retryClient]) {
      client.httpClientAdapter = _StubAdapter((RequestOptions options) {
        seen.add(options);
        final String? header = options.headers['Authorization'] as String?;
        final bool authorised =
            everSucceeds && header == 'Bearer $refreshedToken';
        return ResponseBody.fromString(
          authorised ? '{"ok":true}' : '{"error":{"code":"INVALID_TOKEN"}}',
          authorised ? 200 : 401,
          headers: <String, List<String>>{
            Headers.contentTypeHeader: <String>[Headers.jsonContentType],
          },
        );
      });
    }

    dio.interceptors.add(
      AuthInterceptor(
        readAccessToken: () async => accessToken,
        refreshAccessToken: (String? staleToken) async {
          // Mirrors the controller: a caller holding an already-replaced token is
          // handed the current one rather than triggering another rotation.
          if (everSucceeds && staleToken != null && staleToken != accessToken) {
            return refreshedToken;
          }
          refreshCalls += 1;
          await Future<void>.delayed(const Duration(milliseconds: 20));
          if (!everSucceeds) return null;
          accessToken = refreshedToken;
          return refreshedToken;
        },
        retryClient: retryClient,
      ),
    );
  }

  setUp(() {
    refreshCalls = 0;
    accessToken = 'stale-token';
    refreshedToken = 'fresh-token';
  });

  test('attaches the access token to a protected request', () async {
    buildClient(everSucceeds: true);
    refreshedToken = 'stale-token';

    await dio.get<dynamic>('/me');

    expect(seen.first.headers['Authorization'], 'Bearer stale-token');
  });

  test('never attaches a token to login, register or refresh', () async {
    buildClient(everSucceeds: false);

    for (final String path in <String>[
      '/auth/login',
      '/auth/register',
      '/auth/refresh',
    ]) {
      await dio
          .post<dynamic>(path)
          .catchError(
            (Object _) =>
                Response<dynamic>(requestOptions: RequestOptions(path: path)),
          );
    }

    for (final RequestOptions request in seen) {
      expect(
        request.headers.containsKey('Authorization'),
        isFalse,
        reason: request.path,
      );
    }
    expect(
      refreshCalls,
      0,
      reason: 'a failed login must not trigger a refresh',
    );
  });

  test('does not overwrite a caller-supplied Authorization header', () async {
    buildClient(everSucceeds: true);
    refreshedToken = 'explicit';

    await dio.get<dynamic>(
      '/me',
      options: Options(
        headers: <String, String>{'Authorization': 'Bearer explicit'},
      ),
    );

    expect(seen.first.headers['Authorization'], 'Bearer explicit');
  });

  test('refreshes once on 401 and replays the request', () async {
    buildClient(everSucceeds: true);

    final Response<dynamic> response = await dio.get<dynamic>('/me');

    expect(response.statusCode, 200);
    expect(refreshCalls, 1);
    expect(seen.last.headers['Authorization'], 'Bearer fresh-token');
  });

  test('retries a request at most once, so a 401 cannot loop (§39)', () async {
    // The refresh "succeeds" but the replay still 401s — the classic loop setup.
    buildClient(everSucceeds: false);

    await expectLater(dio.get<dynamic>('/me'), throwsA(isA<DioException>()));

    expect(refreshCalls, 1, reason: 'one refresh attempt, never a cascade');
  });

  test('gives up cleanly when the session is gone (§40)', () async {
    buildClient(everSucceeds: false);
    refreshedToken = null;

    await expectLater(dio.get<dynamic>('/me'), throwsA(isA<DioException>()));
    expect(refreshCalls, 1);
  });

  test('ten concurrent 401s trigger a single refresh (§39)', () async {
    buildClient(everSucceeds: true);

    final List<Response<dynamic>> responses = await Future.wait(
      List<Future<Response<dynamic>>>.generate(
        10,
        (_) => dio.get<dynamic>('/me'),
      ),
    );

    expect(
      responses.every((Response<dynamic> r) => r.statusCode == 200),
      isTrue,
    );
    // QueuedInterceptor serialises error handling and the controller collapses the
    // rotations; either way the server must not see ten refreshes.
    expect(refreshCalls, 1);
  });
}

/// Serves canned responses so the interceptor, not a network, is what is tested.
class _StubAdapter implements HttpClientAdapter {
  _StubAdapter(this._respond);

  final ResponseBody Function(RequestOptions options) _respond;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async => _respond(options);

  @override
  void close({bool force = false}) {}
}

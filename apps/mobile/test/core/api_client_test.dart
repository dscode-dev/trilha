import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/app/config/app_config.dart';
import 'package:trilha_mobile/app/config/app_environment.dart';
import 'package:trilha_mobile/core/errors/app_exception.dart';
import 'package:trilha_mobile/core/logging/app_logger.dart';
import 'package:trilha_mobile/core/networking/api_client.dart';
import 'package:trilha_mobile/core/networking/interceptors.dart';

/// Answers requests locally so the client's own behaviour — headers, base URL,
/// error translation — is what is under test, not a live server.
class _RecordingAdapter implements HttpClientAdapter {
  _RecordingAdapter(this._respond);

  final ResponseBody Function(RequestOptions options) _respond;
  final List<RequestOptions> received = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    received.add(options);
    return _respond(options);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody _json(
  Object? body, {
  int statusCode = 200,
  Map<String, List<String>>? headers,
}) {
  return ResponseBody.fromString(
    body == null ? '' : jsonEncode(body),
    statusCode,
    headers: <String, List<String>>{
      Headers.contentTypeHeader: <String>[Headers.jsonContentType],
      ...?headers,
    },
  );
}

ApiClient _client(_RecordingAdapter adapter) {
  final Dio dio = Dio()..httpClientAdapter = adapter;
  return ApiClient(
    config: AppConfig.forEnvironment(AppEnvironment.development),
    logger: const AppLogger(name: 'test'),
    dio: dio,
  );
}

void main() {
  group('ApiClient', () {
    test('applies the configured base URL', () async {
      final adapter = _RecordingAdapter(
        (_) => _json(<String, Object?>{'status': 'ok'}),
      );

      await _client(adapter).get<Map<String, dynamic>>('/health');

      expect(
        adapter.received.single.uri.toString(),
        'http://localhost:3000/api/v1/health',
      );
    });

    test('stamps a correlation id on every request (§12)', () async {
      final adapter = _RecordingAdapter(
        (_) => _json(<String, Object?>{'status': 'ok'}),
      );
      final ApiClient client = _client(adapter);

      await client.get<Map<String, dynamic>>('/health');
      await client.get<Map<String, dynamic>>('/ready');

      final List<String> ids = adapter.received
          .map((o) => o.headers[kRequestIdHeader]! as String)
          .toList();

      expect(
        ids,
        everyElement(
          matches(
            RegExp(
              r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-'
              r'[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
            ),
          ),
        ),
      );
      expect(ids.toSet().length, 2, reason: 'each request needs its own id');
    });

    test('does not overwrite a caller-supplied correlation id', () async {
      final adapter = _RecordingAdapter(
        (_) => _json(<String, Object?>{'status': 'ok'}),
      );
      final Dio dio = Dio()..httpClientAdapter = adapter;
      final ApiClient client = ApiClient(
        config: AppConfig.forEnvironment(AppEnvironment.development),
        logger: const AppLogger(name: 'test'),
        dio: dio,
      );

      await client.raw.get<Map<String, dynamic>>(
        '/health',
        options: Options(
          headers: <String, String>{kRequestIdHeader: 'caller-id'},
        ),
      );

      expect(adapter.received.single.headers[kRequestIdHeader], 'caller-id');
    });

    test('returns decoded data on success', () async {
      final adapter = _RecordingAdapter(
        (_) => _json(<String, Object?>{'status': 'ok'}),
      );

      final Map<String, dynamic> result = await _client(adapter)
          .get<Map<String, dynamic>>('/health');

      expect(result['status'], 'ok');
    });

    test('translates an error response into a typed ApiException', () async {
      final adapter = _RecordingAdapter(
        (_) => _json(<String, Object?>{
          'error': <String, Object?>{
            'code': 'NOT_FOUND',
            'message': 'Route not found',
            'requestId': 'trace-9',
          },
        }, statusCode: 404),
      );

      await expectLater(
        _client(adapter).get<Map<String, dynamic>>('/nope'),
        throwsA(
          isA<ApiException>()
              .having((e) => e.kind, 'kind', AppErrorKind.notFound)
              .having((e) => e.code, 'code', 'NOT_FOUND')
              .having((e) => e.requestId, 'requestId', 'trace-9'),
        ),
      );
    });

    test('never leaks a DioException to the caller', () async {
      final adapter = _RecordingAdapter(
        (_) => throw StateError('socket exploded'),
      );

      try {
        await _client(adapter).get<Map<String, dynamic>>('/health');
        fail('expected a throw');
      } on Object catch (error) {
        expect(error, isA<AppException>());
        expect(error, isNot(isA<DioException>()));
      }
    });

    test('supports cancellation', () async {
      final CancelToken token = CancelToken();
      final adapter = _RecordingAdapter((_) {
        token.cancel('user navigated away');
        return _json(<String, Object?>{'status': 'ok'});
      });

      await expectLater(
        _client(adapter)
            .get<Map<String, dynamic>>('/health', cancelToken: token),
        throwsA(
          isA<ApiException>().having(
            (e) => e.kind,
            'kind',
            AppErrorKind.cancelled,
          ),
        ),
      );
    });
  });
}

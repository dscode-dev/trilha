import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/app/config/app_config.dart';
import 'package:trilha_mobile/app/config/app_environment.dart';
import 'package:trilha_mobile/core/errors/app_exception.dart';
import 'package:trilha_mobile/core/errors/app_failure.dart';
import 'package:trilha_mobile/core/logging/app_logger.dart';
import 'package:trilha_mobile/core/networking/api_client.dart';
import 'package:trilha_mobile/features/routing/data/routing_api.dart';
import 'package:trilha_mobile/features/routing/domain/route.dart';

import '../../support/places_fakes.dart';
import '../../support/routing_fakes.dart';

/// The wire contract between the app and `POST /routes/calculate` (§66).
void main() {
  late _RecordingAdapter adapter;

  RoutingApi api() => RoutingApi(
    ApiClient(
      config: AppConfig.forEnvironment(AppEnvironment.development),
      logger: const AppLogger(name: 'test'),
      dio: Dio()..httpClientAdapter = adapter,
    ),
  );

  Future<TrilhaRoute> calculate() => api().calculate(
    origin: originEndpoint(),
    destination: destinationEndpoint(),
  );

  /// A response shaped exactly as the backend documents it.
  Map<String, Object?> routeResponse({List<List<double>>? coordinates}) =>
      <String, Object?>{
        'geometry': <String, Object?>{
          'type': 'LineString',
          'coordinates':
              coordinates ??
              <List<double>>[
                <double>[-34.8711, -8.0631],
                <double>[-34.8553, -8.0089],
                <double>[-34.8455, -7.9939],
              ],
        },
        'distanceMeters': 121000.4,
        'durationSeconds': 6480.7,
        'bounds': <String, Object?>{
          'north': -7.9939,
          'south': -8.0631,
          'east': -34.8455,
          'west': -34.8711,
        },
        'legs': <Object?>[
          <String, Object?>{
            'distanceMeters': 121000,
            'durationSeconds': 6480,
            'summary': 'BR-101',
          },
        ],
      };

  setUp(() {
    adapter = _RecordingAdapter((_) => _json(routeResponse()));
  });

  group('request', () {
    test('posts to the routing endpoint', () async {
      await calculate();

      expect(
        adapter.received.single.uri.toString(),
        'http://localhost:3000/api/v1/routes/calculate',
      );
      expect(adapter.received.single.method, 'POST');
    });

    test('asks the backend not to ship the corridor (§47)', () async {
      await calculate();

      final Map<String, Object?> body =
          adapter.received.single.data! as Map<String, Object?>;
      expect(
        body['includeCorridor'],
        isFalse,
        reason: 'the corridor is a large polygon the app never draws',
      );
    });

    test('sends coordinates and the Place id only when there is one', () async {
      await calculate();

      final Map<String, Object?> body =
          adapter.received.single.data! as Map<String, Object?>;
      final Map<String, Object?> origin =
          body['origin']! as Map<String, Object?>;
      final Map<String, Object?> destination =
          body['destination']! as Map<String, Object?>;

      expect(origin['latitude'], kMarcoZero.latitude);
      expect(origin['longitude'], kMarcoZero.longitude);
      expect(
        origin.containsKey('placeId'),
        isFalse,
        reason: 'a null placeId is omitted, not sent as null',
      );
      expect(destination['placeId'], 'olinda-id');
    });
  });

  group('response', () {
    test('reads GeoJSON longitude-first into latitude-first points', () async {
      final TrilhaRoute route = await calculate();

      expect(route.geometry, hasLength(3));
      expect(route.geometry.first.latitude, -8.0631);
      expect(route.geometry.first.longitude, -34.8711);
    });

    test('rounds distance and duration to whole units', () async {
      final TrilhaRoute route = await calculate();

      expect(route.distanceMeters, 121000);
      expect(route.durationSeconds, 6481);
    });

    test('keeps the endpoints the caller asked about', () async {
      final TrilhaRoute route = await calculate();

      expect(route.origin, originEndpoint());
      expect(route.destination, destinationEndpoint());
    });

    test('reads bounds and legs', () async {
      final TrilhaRoute route = await calculate();

      expect(route.bounds.north, -7.9939);
      expect(route.bounds.west, -34.8711);
      expect(route.legs.single.summary, 'BR-101');
    });
  });

  group('malformed responses', () {
    test(
      'rejects a body with no geometry rather than drawing nothing',
      () async {
        final Map<String, Object?> body = routeResponse()..remove('geometry');
        adapter = _RecordingAdapter((_) => _json(body));

        await expectLater(calculate(), throwsA(isA<AppFailure>()));
      },
    );

    test('rejects a line too short to draw', () async {
      adapter = _RecordingAdapter(
        (_) => _json(
          routeResponse(
            coordinates: <List<double>>[
              <double>[-34.8711, -8.0631],
            ],
          ),
        ),
      );

      await expectLater(calculate(), throwsA(isA<AppFailure>()));
    });
  });

  group('errors', () {
    test('maps a backend routing refusal to a typed failure (§56)', () async {
      adapter = _RecordingAdapter(
        (_) => _json(<String, Object?>{
          'error': <String, Object?>{
            'code': 'ROUTE_NOT_FOUND',
            'message': 'No route between those points.',
          },
        }, statusCode: 422),
      );

      await expectLater(
        calculate(),
        throwsA(
          isA<AppFailure>().having(
            (AppFailure f) => f.kind,
            'kind',
            FailureKind.notRoutable,
          ),
        ),
      );
    });

    test('maps provider unavailability to a retryable failure', () async {
      adapter = _RecordingAdapter(
        (_) => _json(<String, Object?>{
          'error': <String, Object?>{
            'code': 'PROVIDER_UNAVAILABLE',
            'message': 'Upstream is down.',
          },
        }, statusCode: 503),
      );

      await expectLater(
        calculate(),
        throwsA(
          isA<AppFailure>()
              .having(
                (AppFailure f) => f.kind,
                'kind',
                FailureKind.providerUnavailable,
              )
              .having((AppFailure f) => f.isRetryable, 'isRetryable', isTrue),
        ),
      );
    });

    test('has a typed kind for every routing code the backend emits', () {
      /* The list is the backend's `ErrorCode` members reachable from the routing
         module. An unmapped code degrades to `unknown`, which the panel renders as
         a generic apology — correct, but it loses the one thing the user needs to
         know: whether retrying is worth it. */
      const List<String> emitted = <String>[
        'ROUTE_NOT_FOUND',
        'INVALID_ROUTE_REQUEST',
        'PROVIDER_TIMEOUT',
        'PROVIDER_UNAVAILABLE',
        'PROVIDER_RATE_LIMITED',
        'TOO_MANY_REQUESTS',
      ];

      for (final String code in emitted) {
        final AppFailure failure = AppFailure.from(
          ApiException(
            kind: AppErrorKind.badRequest,
            message: 'x',
            statusCode: 400,
            code: code,
          ),
        );

        expect(failure.kind, isNot(FailureKind.unknown), reason: code);
      }
    });

    test('maps rate limiting so the panel can say to wait', () async {
      adapter = _RecordingAdapter(
        (_) => _json(<String, Object?>{
          'error': <String, Object?>{
            'code': 'TOO_MANY_REQUESTS',
            'message': 'Slow down.',
          },
        }, statusCode: 429),
      );

      await expectLater(
        calculate(),
        throwsA(
          isA<AppFailure>().having(
            (AppFailure f) => f.kind,
            'kind',
            FailureKind.rateLimited,
          ),
        ),
      );
    });
  });
}

/// Answers requests locally, so the contract is what is under test, not a server.
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

ResponseBody _json(Object? body, {int statusCode = 200}) =>
    ResponseBody.fromString(
      jsonEncode(body),
      statusCode,
      headers: <String, List<String>>{
        Headers.contentTypeHeader: <String>[Headers.jsonContentType],
      },
    );

import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/app/config/app_config.dart';
import 'package:trilha_mobile/app/config/app_environment.dart';
import 'package:trilha_mobile/core/errors/app_failure.dart';
import 'package:trilha_mobile/core/logging/app_logger.dart';
import 'package:trilha_mobile/core/networking/api_client.dart';
import 'package:trilha_mobile/features/discovery/data/discovery_api.dart';
import 'package:trilha_mobile/features/discovery/domain/route_candidate.dart';

import '../../support/places_fakes.dart';
import '../../support/routing_fakes.dart';

/// The wire contract between the app and `POST /discovery/routes` (§75).
void main() {
  late _RecordingAdapter adapter;

  DiscoveryApi api() => DiscoveryApi(
    ApiClient(
      config: AppConfig.forEnvironment(AppEnvironment.development),
      logger: const AppLogger(name: 'test'),
      dio: Dio()..httpClientAdapter = adapter,
    ),
  );

  Future<DiscoveryResult> discover({
    List<String> categories = const <String>[],
  }) => api().discover(
    origin: originEndpoint(),
    destination: destinationEndpoint(),
    categories: categories,
  );

  Map<String, Object?> response({
    List<Object?>? candidates,
  }) => <String, Object?>{
    'route': <String, Object?>{
      'distanceMeters': 121000,
      'durationSeconds': 6480,
    },
    'policyVersion': 'v1',
    'candidates':
        candidates ??
        <Object?>[
          <String, Object?>{
            'place': <String, Object?>{
              'id': 'museum-id',
              'name': 'Museu do Homem',
              'categoryId': 'HISTORY_CULTURE',
              'latitude': -7.83,
              'longitude': -34.845,
              'provenance': 'COMMUNITY',
            },
            'distanceFromRouteMeters': 1200.6,
            'detourDistanceMeters': 3400.2,
            'detourDurationSeconds': 420.4,
            'routeProgress': 0.42,
            'relevanceScore': 0.91,
            'relevanceReasons': <String>['VERY_CLOSE_TO_ROUTE', 'LOW_DETOUR'],
          },
        ],
    'diagnostics': <String, Object?>{
      'spatialCandidates': 37,
      'evaluatedCandidates': 20,
      'returnedCandidates': 1,
    },
  };

  setUp(() {
    adapter = _RecordingAdapter((_) => _json(response()));
  });

  group('request', () {
    test('posts to the discovery endpoint', () async {
      await discover();

      expect(
        adapter.received.single.uri.toString(),
        'http://localhost:3000/api/v1/discovery/routes',
      );
      expect(adapter.received.single.method, 'POST');
    });

    test('sends endpoints rather than a route geometry (§9)', () async {
      await discover();

      final Map<String, Object?> body =
          adapter.received.single.data! as Map<String, Object?>;

      /* An attacker-supplied LineString would be an attacker-chosen search area over
         a metered pipeline, so the backend recalculates from the same two points. */
      expect(body.containsKey('geometry'), isFalse);
      expect(body.containsKey('routeGeometry'), isFalse);
      expect(
        (body['origin']! as Map<String, Object?>)['latitude'],
        kMarcoZero.latitude,
      );
    });

    test('sends the Place id only when there is one', () async {
      await discover();

      final Map<String, Object?> body =
          adapter.received.single.data! as Map<String, Object?>;

      expect(
        (body['origin']! as Map<String, Object?>).containsKey('placeId'),
        isFalse,
      );
      expect(
        (body['destination']! as Map<String, Object?>)['placeId'],
        'olinda-id',
      );
    });

    test('sends the category filter', () async {
      await discover(categories: <String>['FOOD', 'NATURE']);

      final Map<String, Object?> body =
          adapter.received.single.data! as Map<String, Object?>;
      expect(body['categories'], <String>['FOOD', 'NATURE']);
    });

    test('omits the detour ceiling so the server default applies', () async {
      await discover();

      final Map<String, Object?> body =
          adapter.received.single.data! as Map<String, Object?>;
      expect(body.containsKey('maxDetourMinutes'), isFalse);
    });
  });

  group('response', () {
    test('reads a candidate into the domain', () async {
      final DiscoveryResult result = await discover();
      final RouteCandidate candidate = result.candidates.single;

      expect(candidate.place.name, 'Museu do Homem');
      expect(candidate.place.position.latitude, -7.83);
      expect(candidate.distanceFromRouteMeters, 1201);
      expect(candidate.detourDurationSeconds, 420);
      expect(candidate.routeProgress, 0.42);
    });

    test('keeps detour and distance from the route distinct (§17)', () async {
      final RouteCandidate candidate = (await discover()).candidates.single;

      expect(
        candidate.distanceFromRouteMeters,
        isNot(candidate.detourDistanceMeters),
      );
    });

    test('maps reason codes to the domain enum', () async {
      final RouteCandidate candidate = (await discover()).candidates.single;

      expect(candidate.relevanceReasons, <RelevanceReason>[
        RelevanceReason.veryCloseToRoute,
        RelevanceReason.lowDetour,
      ]);
    });

    test('degrades an unknown reason code rather than throwing', () async {
      final Map<String, Object?> body = response();
      final List<Object?> candidates = body['candidates']! as List<Object?>;
      (candidates.first! as Map<String, Object?>)['relevanceReasons'] =
          <String>['SOMETHING_NEW'];
      adapter = _RecordingAdapter((_) => _json(body));

      final RouteCandidate candidate = (await discover()).candidates.single;
      expect(candidate.relevanceReasons, <RelevanceReason>[
        RelevanceReason.unknown,
      ]);
    });

    test('carries the policy version', () async {
      expect((await discover()).policyVersion, 'v1');
    });

    test('accepts an empty candidate list as a valid answer (§52)', () async {
      adapter = _RecordingAdapter(
        (_) => _json(response(candidates: <Object?>[])),
      );

      final DiscoveryResult result = await discover();

      expect(result.candidates, isEmpty);
      expect(result.policyVersion, 'v1');
    });

    test('rejects a body with no candidate array', () async {
      final Map<String, Object?> body = response()..remove('candidates');
      adapter = _RecordingAdapter((_) => _json(body));

      await expectLater(discover(), throwsA(isA<AppFailure>()));
    });
  });

  group('errors', () {
    test('maps provider unavailability to a typed failure', () async {
      adapter = _RecordingAdapter(
        (_) => _json(<String, Object?>{
          'error': <String, Object?>{
            'code': 'PROVIDER_UNAVAILABLE',
            'message': 'Upstream is down.',
          },
        }, statusCode: 503),
      );

      await expectLater(
        discover(),
        throwsA(
          isA<AppFailure>().having(
            (AppFailure f) => f.kind,
            'kind',
            FailureKind.providerUnavailable,
          ),
        ),
      );
    });

    test('maps rate limiting so the sheet can say to wait', () async {
      adapter = _RecordingAdapter(
        (_) => _json(<String, Object?>{
          'error': <String, Object?>{
            'code': 'TOO_MANY_REQUESTS',
            'message': 'Slow down.',
          },
        }, statusCode: 429),
      );

      await expectLater(
        discover(),
        throwsA(
          isA<AppFailure>().having(
            (AppFailure f) => f.kind,
            'kind',
            FailureKind.rateLimited,
          ),
        ),
      );
    });

    test('maps an unroutable pair distinctly', () async {
      adapter = _RecordingAdapter(
        (_) => _json(<String, Object?>{
          'error': <String, Object?>{
            'code': 'ROUTE_NOT_FOUND',
            'message': 'No route.',
          },
        }, statusCode: 422),
      );

      await expectLater(
        discover(),
        throwsA(
          isA<AppFailure>().having(
            (AppFailure f) => f.kind,
            'kind',
            FailureKind.notRoutable,
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

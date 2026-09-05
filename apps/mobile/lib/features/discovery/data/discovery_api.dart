import 'package:dio/dio.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/networking/api_client.dart';
import '../../places/domain/place.dart';
import '../../routing/domain/route.dart';
import '../domain/route_candidate.dart';

/// The discovery endpoint the app consumes.
///
/// An interface, so tests can substitute the HTTP boundary — the same pattern used
/// for auth, places and routing.
abstract interface class DiscoveryEndpoints {
  Future<DiscoveryResult> discover({
    required RouteEndpoint origin,
    required RouteEndpoint destination,
    required List<String> categories,
    int? maxDetourMinutes,
    CancelToken? cancelToken,
  });
}

class DiscoveryApi implements DiscoveryEndpoints {
  const DiscoveryApi(this._client);

  final ApiClient _client;

  @override
  Future<DiscoveryResult> discover({
    required RouteEndpoint origin,
    required RouteEndpoint destination,
    required List<String> categories,
    int? maxDetourMinutes,
    CancelToken? cancelToken,
  }) async {
    try {
      final Map<String, dynamic> json = await _client
          .post<Map<String, dynamic>>(
            '/discovery/routes',
            data: <String, dynamic>{
              /* Endpoints, not the geometry. The backend recalculates the route from
                 the same two points, because a client-supplied LineString would be an
                 attacker-chosen search area over a metered pipeline (§9). */
              'origin': _endpointPayload(origin),
              'destination': _endpointPayload(destination),
              'categories': categories,
              'maxDetourMinutes': ?maxDetourMinutes,
            },
            cancelToken: cancelToken,
          );

      return _resultFrom(json);
    } on Object catch (error) {
      throw AppFailure.from(error);
    }
  }

  static Map<String, dynamic> _endpointPayload(RouteEndpoint endpoint) =>
      <String, dynamic>{
        'latitude': endpoint.position.latitude,
        'longitude': endpoint.position.longitude,
        'placeId': ?endpoint.placeId,
      };

  DiscoveryResult _resultFrom(Map<String, dynamic> json) {
    final Object? rawCandidates = json['candidates'];
    if (rawCandidates is! List) {
      throw const AppFailure(
        kind: FailureKind.unknown,
        message: 'Trilha retornou descobertas em um formato inesperado.',
      );
    }

    return DiscoveryResult(
      policyVersion: json['policyVersion'] as String? ?? 'unknown',
      candidates: rawCandidates
          .whereType<Map<String, dynamic>>()
          .map(_candidateFrom)
          .toList(),
    );
  }

  RouteCandidate _candidateFrom(Map<String, dynamic> json) {
    final Map<String, dynamic> place = json['place']! as Map<String, dynamic>;

    return RouteCandidate(
      place: CandidatePlace(
        id: place['id']! as String,
        name: place['name']! as String,
        categoryId: place['categoryId']! as String,
        position: LatLng(
          latitude: (place['latitude']! as num).toDouble(),
          longitude: (place['longitude']! as num).toDouble(),
        ),
      ),
      distanceFromRouteMeters: (json['distanceFromRouteMeters']! as num)
          .round(),
      detourDistanceMeters: (json['detourDistanceMeters']! as num).round(),
      detourDurationSeconds: (json['detourDurationSeconds']! as num).round(),
      routeProgress: (json['routeProgress']! as num).toDouble(),
      relevanceScore: (json['relevanceScore']! as num).toDouble(),
      /* Unknown codes become `unknown` rather than throwing: a reason added
         server-side must degrade to silence, not to a broken screen. */
      relevanceReasons:
          (json['relevanceReasons'] as List<dynamic>? ?? <dynamic>[])
              .whereType<String>()
              .map(RelevanceReason.fromCode)
              .toList(),
    );
  }
}

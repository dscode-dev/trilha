import 'package:dio/dio.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/networking/api_client.dart';
import '../../places/domain/place.dart';
import '../domain/route.dart';

/// The routing endpoint the app consumes.
///
/// An interface, so tests can substitute the HTTP boundary — the same pattern used
/// for auth and places.
abstract interface class RoutingEndpoints {
  Future<TrilhaRoute> calculate({
    required RouteEndpoint origin,
    required RouteEndpoint destination,
    CancelToken? cancelToken,
  });
}

class RoutingApi implements RoutingEndpoints {
  const RoutingApi(this._client);

  final ApiClient _client;

  @override
  Future<TrilhaRoute> calculate({
    required RouteEndpoint origin,
    required RouteEndpoint destination,
    CancelToken? cancelToken,
  }) async {
    try {
      final Map<String, dynamic> json = await _client
          .post<Map<String, dynamic>>(
            '/routes/calculate',
            data: <String, dynamic>{
              'origin': _endpointPayload(origin),
              'destination': _endpointPayload(destination),
              // The corridor is a large polygon the app does not draw; PR-04 consumes it
              // server-side, so there is no reason to ship it to a phone (§47).
              'includeCorridor': false,
            },
            cancelToken: cancelToken,
          );

      return _routeFrom(json, origin: origin, destination: destination);
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

  TrilhaRoute _routeFrom(
    Map<String, dynamic> json, {
    required RouteEndpoint origin,
    required RouteEndpoint destination,
  }) {
    final Object? geometry = json['geometry'];
    if (geometry is! Map<String, dynamic>) {
      throw const AppFailure(
        kind: FailureKind.unknown,
        message: 'Trilha returned a route without geometry.',
      );
    }

    final Object? rawCoordinates = geometry['coordinates'];
    if (rawCoordinates is! List || rawCoordinates.length < 2) {
      throw const AppFailure(
        kind: FailureKind.unknown,
        message: 'Trilha returned a route that cannot be drawn.',
      );
    }

    /* GeoJSON is [longitude, latitude]; LatLng is the other way round. Getting this
       backwards draws the route in the wrong hemisphere with no error. */
    final List<LatLng> points = rawCoordinates
        .whereType<List<dynamic>>()
        .where((List<dynamic> pair) => pair.length >= 2)
        .map(
          (List<dynamic> pair) => LatLng(
            latitude: (pair[1] as num).toDouble(),
            longitude: (pair[0] as num).toDouble(),
          ),
        )
        .toList();

    final Object? bounds = json['bounds'];
    final Map<String, dynamic> boundsJson = bounds is Map<String, dynamic>
        ? bounds
        : <String, dynamic>{};

    return TrilhaRoute(
      origin: origin,
      destination: destination,
      geometry: points,
      distanceMeters: (json['distanceMeters']! as num).round(),
      durationSeconds: (json['durationSeconds']! as num).round(),
      bounds: MapBounds(
        north: (boundsJson['north']! as num).toDouble(),
        south: (boundsJson['south']! as num).toDouble(),
        east: (boundsJson['east']! as num).toDouble(),
        west: (boundsJson['west']! as num).toDouble(),
      ),
      legs: (json['legs'] as List<dynamic>? ?? <dynamic>[])
          .whereType<Map<String, dynamic>>()
          .map(
            (Map<String, dynamic> leg) => RouteLeg(
              distanceMeters: (leg['distanceMeters']! as num).round(),
              durationSeconds: (leg['durationSeconds']! as num).round(),
              summary: leg['summary'] as String?,
            ),
          )
          .toList(),
    );
  }
}

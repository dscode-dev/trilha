import '../../../core/errors/app_failure.dart';
import '../../../core/networking/api_client.dart';
import '../../places/domain/place.dart';
import '../domain/trail.dart';

/// The trail endpoints the app consumes.
///
/// An interface, so tests can substitute the HTTP boundary — the same pattern used
/// for auth, places, routing and discovery.
abstract interface class TrailEndpoints {
  Future<Trail> create({
    required TrailEndpoint origin,
    required TrailEndpoint destination,
  });
  Future<Trail> byId(String trailId);
  Future<TrailPage> list({String? cursor, int limit});

  Future<Trail> addStop({
    required String trailId,
    required String placeId,
    required TrailStopSource source,
    required int expectedRevision,
  });

  Future<Trail> removeStop({
    required String trailId,
    required String stopId,
    required int expectedRevision,
  });

  Future<Trail> reorderStops({
    required String trailId,
    required List<String> stopIds,
    required int expectedRevision,
  });

  Future<Trail> recalculate({
    required String trailId,
    required int expectedRevision,
  });
  Future<Trail> finalize({
    required String trailId,
    required int expectedRevision,
  });
  Future<void> delete(String trailId);
}

class TrailPage {
  const TrailPage({required this.trails, this.nextCursor});

  final List<TrailSummary> trails;
  final String? nextCursor;
}

class TrailsApi implements TrailEndpoints {
  const TrailsApi(this._client);

  final ApiClient _client;

  @override
  Future<Trail> create({
    required TrailEndpoint origin,
    required TrailEndpoint destination,
  }) => _mutate(
    () => _client.post<Map<String, dynamic>>(
      '/trails',
      data: <String, dynamic>{
        'origin': _endpoint(origin),
        'destination': _endpoint(destination),
      },
    ),
  );

  @override
  Future<Trail> byId(String trailId) =>
      _mutate(() => _client.get<Map<String, dynamic>>('/trails/$trailId'));

  @override
  Future<TrailPage> list({String? cursor, int limit = 20}) async {
    try {
      final Map<String, dynamic> json = await _client.get<Map<String, dynamic>>(
        '/trails',
        queryParameters: <String, dynamic>{'limit': limit, 'cursor': ?cursor},
      );

      return TrailPage(
        trails: (json['trails'] as List<dynamic>? ?? <dynamic>[])
            .whereType<Map<String, dynamic>>()
            .map(_summaryFrom)
            .toList(),
        nextCursor: json['nextCursor'] as String?,
      );
    } on Object catch (error) {
      throw AppFailure.from(error);
    }
  }

  @override
  Future<Trail> addStop({
    required String trailId,
    required String placeId,
    required TrailStopSource source,
    required int expectedRevision,
  }) => _mutate(
    () => _client.post<Map<String, dynamic>>(
      '/trails/$trailId/stops',
      data: <String, dynamic>{
        'placeId': placeId,
        'source': source.code,
        'expectedRevision': expectedRevision,
      },
    ),
  );

  @override
  Future<Trail> removeStop({
    required String trailId,
    required String stopId,
    required int expectedRevision,
  }) => _mutate(
    () => _client.delete<Map<String, dynamic>>(
      '/trails/$trailId/stops/$stopId',
      data: <String, dynamic>{'expectedRevision': expectedRevision},
    ),
  );

  @override
  Future<Trail> reorderStops({
    required String trailId,
    required List<String> stopIds,
    required int expectedRevision,
  }) => _mutate(
    () => _client.put<Map<String, dynamic>>(
      '/trails/$trailId/stops/order',
      data: <String, dynamic>{
        'stopIds': stopIds,
        'expectedRevision': expectedRevision,
      },
    ),
  );

  @override
  Future<Trail> recalculate({
    required String trailId,
    required int expectedRevision,
  }) => _mutate(
    () => _client.post<Map<String, dynamic>>(
      '/trails/$trailId/recalculate',
      data: <String, dynamic>{'expectedRevision': expectedRevision},
    ),
  );

  @override
  Future<Trail> finalize({
    required String trailId,
    required int expectedRevision,
  }) => _mutate(
    () => _client.post<Map<String, dynamic>>(
      '/trails/$trailId/finalize',
      data: <String, dynamic>{'expectedRevision': expectedRevision},
    ),
  );

  @override
  Future<void> delete(String trailId) async {
    try {
      await _client.delete<void>('/trails/$trailId');
    } on Object catch (error) {
      throw AppFailure.from(error);
    }
  }

  /// Every mutation returns the whole trail, so the client always has the next
  /// revision without a second round trip.
  Future<Trail> _mutate(Future<Map<String, dynamic>> Function() call) async {
    try {
      return _trailFrom(await call());
    } on Object catch (error) {
      throw AppFailure.from(error);
    }
  }

  static Map<String, dynamic> _endpoint(TrailEndpoint endpoint) =>
      <String, dynamic>{
        'latitude': endpoint.position.latitude,
        'longitude': endpoint.position.longitude,
        'placeId': ?endpoint.placeId,
        'label': ?endpoint.label,
      };

  static TrailEndpoint _endpointFrom(Map<String, dynamic> json) =>
      TrailEndpoint(
        position: LatLng(
          latitude: (json['latitude']! as num).toDouble(),
          longitude: (json['longitude']! as num).toDouble(),
        ),
        placeId: json['placeId'] as String?,
        label: json['label'] as String?,
      );

  static TrailMetrics? _metricsFrom(Object? json) {
    if (json is! Map<String, dynamic>) return null;

    return TrailMetrics(
      distanceMeters: (json['distanceMeters']! as num).round(),
      durationSeconds: (json['durationSeconds']! as num).round(),
    );
  }

  static Trail _trailFrom(Map<String, dynamic> json) {
    final Object? route = json['route'];

    return Trail(
      id: json['id']! as String,
      status: TrailStatus.fromCode(json['status']! as String),
      origin: _endpointFrom(json['origin']! as Map<String, dynamic>),
      destination: _endpointFrom(json['destination']! as Map<String, dynamic>),
      stops: (json['stops'] as List<dynamic>? ?? <dynamic>[])
          .whereType<Map<String, dynamic>>()
          .map(_stopFrom)
          .toList(),
      revision: (json['revision']! as num).toInt(),
      route: route is Map<String, dynamic> ? _routeFrom(route) : null,
      baseRoute: _metricsFrom(json['baseRoute']),
      detour: _detourFrom(json['detour']),
      routeIsCurrent: json['routeIsCurrent'] as bool? ?? false,
      maxStops: (json['maxStops'] as num?)?.toInt() ?? 0,
      updatedAt: DateTime.parse(json['updatedAt']! as String),
    );
  }

  static TrailMetrics? _detourFrom(Object? json) {
    if (json is! Map<String, dynamic>) return null;

    return TrailMetrics(
      distanceMeters: (json['extraDistanceMeters']! as num).round(),
      durationSeconds: (json['extraDurationSeconds']! as num).round(),
    );
  }

  static TrailRoute _routeFrom(Map<String, dynamic> json) {
    final Map<String, dynamic> geometry =
        json['geometry']! as Map<String, dynamic>;
    final Map<String, dynamic> bounds = json['bounds']! as Map<String, dynamic>;

    return TrailRoute(
      /* GeoJSON is [longitude, latitude]; LatLng is the other way round. Getting this
         backwards draws the trail in the wrong hemisphere with no error. */
      geometry: (geometry['coordinates'] as List<dynamic>? ?? <dynamic>[])
          .whereType<List<dynamic>>()
          .where((List<dynamic> pair) => pair.length >= 2)
          .map(
            (List<dynamic> pair) => LatLng(
              latitude: (pair[1] as num).toDouble(),
              longitude: (pair[0] as num).toDouble(),
            ),
          )
          .toList(),
      bounds: MapBounds(
        north: (bounds['north']! as num).toDouble(),
        south: (bounds['south']! as num).toDouble(),
        east: (bounds['east']! as num).toDouble(),
        west: (bounds['west']! as num).toDouble(),
      ),
      distanceMeters: (json['distanceMeters']! as num).round(),
      durationSeconds: (json['durationSeconds']! as num).round(),
    );
  }

  static TrailStop _stopFrom(Map<String, dynamic> json) => TrailStop(
    id: json['id']! as String,
    placeId: json['placeId']! as String,
    position: (json['position']! as num).toInt(),
    source: TrailStopSource.fromCode(json['source']! as String),
    placeName: json['placeName']! as String,
    placeCategoryId: json['placeCategoryId']! as String,
    location: LatLng(
      latitude: (json['latitude']! as num).toDouble(),
      longitude: (json['longitude']! as num).toDouble(),
    ),
  );

  static TrailSummary _summaryFrom(Map<String, dynamic> json) => TrailSummary(
    id: json['id']! as String,
    status: TrailStatus.fromCode(json['status']! as String),
    originLabel: json['originLabel'] as String?,
    destinationLabel: json['destinationLabel'] as String?,
    stopCount: (json['stopCount']! as num).toInt(),
    distanceMeters: (json['distanceMeters'] as num?)?.round(),
    durationSeconds: (json['durationSeconds'] as num?)?.round(),
    revision: (json['revision']! as num).toInt(),
    updatedAt: DateTime.parse(json['updatedAt']! as String),
  );
}

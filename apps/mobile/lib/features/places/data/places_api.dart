import 'package:dio/dio.dart';

import '../../../core/networking/api_client.dart';
import '../../../core/errors/app_failure.dart';
import '../domain/place.dart';

/// The Places endpoints the app consumes.
///
/// An interface so tests can replace the HTTP boundary without a network, matching
/// the pattern established for auth in PR-01.
abstract interface class PlacesEndpoints {
  Future<List<PlaceMapItem>> mapItems(
    MapBounds bounds, {
    CancelToken? cancelToken,
  });

  Future<List<PlaceListItem>> search(
    String term, {
    LatLng? near,
    CancelToken? cancelToken,
  });

  Future<List<PlaceListItem>> nearby(
    LatLng centre, {
    int radiusMetres,
    CancelToken? cancelToken,
  });

  Future<PlaceDetail> byId(String id);

  Future<List<PlaceCategory>> categories();

  Future<CreatePlaceResult> create({
    required String name,
    required String categoryId,
    required LatLng position,
    String? description,
  });
}

/// The outcome of a contribution, including any advisory near-duplicates (§52).
class CreatePlaceResult {
  const CreatePlaceResult({
    required this.place,
    required this.possibleDuplicates,
  });

  final PlaceDetail place;
  final List<PlaceListItem> possibleDuplicates;
}

class PlacesApi implements PlacesEndpoints {
  const PlacesApi(this._client);

  final ApiClient _client;

  @override
  Future<List<PlaceMapItem>> mapItems(
    MapBounds bounds, {
    CancelToken? cancelToken,
  }) async {
    final Map<String, dynamic> json = await _guard(
      () => _client.get<Map<String, dynamic>>(
        '/places/map',
        queryParameters: <String, dynamic>{
          'north': bounds.north,
          'south': bounds.south,
          'east': bounds.east,
          'west': bounds.west,
        },
        cancelToken: cancelToken,
      ),
    );

    return _list(json['items']).map(_mapItemFrom).toList();
  }

  @override
  Future<List<PlaceListItem>> search(
    String term, {
    LatLng? near,
    CancelToken? cancelToken,
  }) async {
    final Map<String, dynamic> json = await _guard(
      () => _client.get<Map<String, dynamic>>(
        '/places/search',
        queryParameters: <String, dynamic>{
          'q': term,
          'lat': ?near?.latitude,
          'lng': ?near?.longitude,
        },
        cancelToken: cancelToken,
      ),
    );

    return _list(json['items']).map(_listItemFrom).toList();
  }

  @override
  Future<List<PlaceListItem>> nearby(
    LatLng centre, {
    int radiusMetres = 2000,
    CancelToken? cancelToken,
  }) async {
    final Map<String, dynamic> json = await _guard(
      () => _client.get<Map<String, dynamic>>(
        '/places/nearby',
        queryParameters: <String, dynamic>{
          'lat': centre.latitude,
          'lng': centre.longitude,
          'radiusMeters': radiusMetres,
        },
        cancelToken: cancelToken,
      ),
    );

    return _list(json['items']).map(_listItemFrom).toList();
  }

  @override
  Future<PlaceDetail> byId(String id) async {
    final Map<String, dynamic> json = await _guard(
      () => _client.get<Map<String, dynamic>>('/places/$id'),
    );
    return _detailFrom(json);
  }

  @override
  Future<List<PlaceCategory>> categories() async {
    final List<dynamic> json = await _guard(
      () => _client.get<List<dynamic>>('/places/categories'),
    );

    return json
        .whereType<Map<String, dynamic>>()
        .map(
          (Map<String, dynamic> row) => PlaceCategory(
            id: row['id']! as String,
            label: row['label']! as String,
          ),
        )
        .toList();
  }

  @override
  Future<CreatePlaceResult> create({
    required String name,
    required String categoryId,
    required LatLng position,
    String? description,
  }) async {
    final Map<String, dynamic> json = await _guard(
      () => _client.post<Map<String, dynamic>>(
        '/places',
        data: <String, dynamic>{
          'name': name,
          'categoryId': categoryId,
          'latitude': position.latitude,
          'longitude': position.longitude,
          'description': description,
        },
      ),
    );

    return CreatePlaceResult(
      place: _detailFrom(json['place']! as Map<String, dynamic>),
      possibleDuplicates: _list(json['possibleDuplicates'])
          .map(_listItemFrom)
          .toList(),
    );
  }

  /// Transport failures become [AppFailure], the vocabulary the UI already speaks.
  Future<T> _guard<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on Object catch (error) {
      throw AppFailure.from(error);
    }
  }

  static List<Map<String, dynamic>> _list(Object? value) => value is List
      ? value.whereType<Map<String, dynamic>>().toList()
      : <Map<String, dynamic>>[];

  static LatLng _positionFrom(Map<String, dynamic> json) => LatLng(
    latitude: (json['latitude']! as num).toDouble(),
    longitude: (json['longitude']! as num).toDouble(),
  );

  static PlaceMapItem _mapItemFrom(Map<String, dynamic> json) => PlaceMapItem(
    id: json['id']! as String,
    name: json['name']! as String,
    categoryId: json['categoryId']! as String,
    position: _positionFrom(json),
  );

  static PlaceListItem _listItemFrom(Map<String, dynamic> json) =>
      PlaceListItem(
        id: json['id']! as String,
        name: json['name']! as String,
        categoryId: json['categoryId']! as String,
        position: _positionFrom(json),
        description: json['description'] as String?,
        distanceMetres: (json['distanceMetres'] as num?)?.round(),
      );

  static PlaceDetail _detailFrom(Map<String, dynamic> json) {
    final Object? contributor = json['contributor'];

    return PlaceDetail(
      id: json['id']! as String,
      name: json['name']! as String,
      categoryId: json['categoryId']! as String,
      position: _positionFrom(json),
      provenance: PlaceProvenance.parse(json['provenance'] as String?),
      description: json['description'] as String?,
      contributor: contributor is Map<String, dynamic>
          ? PlaceContributor(
              username: contributor['username']! as String,
              displayName: contributor['displayName']! as String,
            )
          : null,
    );
  }
}

import 'package:flutter_test/flutter_test.dart';
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart' as mapbox;
import 'package:trilha_mobile/features/discovery/domain/route_candidate.dart';
import 'package:trilha_mobile/features/discovery/presentation/candidate_overlay.dart';

import '../../support/discovery_fakes.dart';

/// Candidate markers, asserted through the annotation manager (§56, §57).
///
/// A platform view cannot exist in a test binding, so the SDK's manager is stubbed and
/// the overlay is checked on what it *asks the map to do*.
void main() {
  late _StubPointManager markers;
  late MapboxCandidateOverlay overlay;

  setUp(() {
    markers = _StubPointManager();
    overlay = MapboxCandidateOverlay(markers: markers, markerColor: 0xFF1B7F4B);
  });

  test('draws one marker per candidate', () async {
    await overlay.showCandidates(<RouteCandidate>[candidate(), candidate()]);

    expect(markers.created, hasLength(2));
  });

  test('sends coordinates as longitude, latitude', () async {
    final RouteCandidate only = candidate();
    await overlay.showCandidates(<RouteCandidate>[only]);

    final mapbox.Point point = markers.created.single.geometry;
    /* Reversing these puts every suggestion in the Indian Ocean with no error. */
    expect(point.coordinates.lng, only.place.position.longitude);
    expect(point.coordinates.lat, only.place.position.latitude);
  });

  test('redrawing replaces the previous set instead of stacking', () async {
    await overlay.showCandidates(<RouteCandidate>[candidate()]);
    await overlay.showCandidates(<RouteCandidate>[candidate(), candidate()]);

    expect(markers.created, hasLength(3));
    expect(markers.deleted, hasLength(1));
  });

  test('clearing removes every candidate marker', () async {
    await overlay.showCandidates(<RouteCandidate>[candidate(), candidate()]);
    await overlay.clearCandidates();

    expect(markers.deleted, hasLength(2));
  });

  test('clearing twice is harmless', () async {
    await overlay.showCandidates(<RouteCandidate>[candidate()]);
    await overlay.clearCandidates();
    await overlay.clearCandidates();

    expect(markers.deleted, hasLength(1));
  });

  test('clearing before anything is drawn does nothing', () async {
    await overlay.clearCandidates();

    expect(markers.deleted, isEmpty);
  });

  test(
    'highlighting grows the selected marker and shrinks the rest (§57)',
    () async {
      final RouteCandidate first = candidate();
      final RouteCandidate second = candidate();
      await overlay.showCandidates(<RouteCandidate>[first, second]);

      await overlay.highlight(first.place.id);

      final List<mapbox.PointAnnotation> updated = markers.updated;
      expect(updated, hasLength(2));

      final mapbox.PointAnnotation selected = updated.firstWhere(
        (mapbox.PointAnnotation a) => a.iconSize == 1.6,
      );
      /* Size as well as glyph: a highlight that lives only in a colour is invisible to
       a colour-blind user and competes with the basemap besides. */
      expect(selected.textField, '●');
      expect(
        updated.where((mapbox.PointAnnotation a) => a.iconSize == 1.0),
        hasLength(1),
      );
    },
  );

  test('clearing the highlight returns every marker to resting size', () async {
    await overlay.showCandidates(<RouteCandidate>[candidate(), candidate()]);

    await overlay.highlight(null);

    expect(
      markers.updated.every((mapbox.PointAnnotation a) => a.iconSize == 1.0),
      isTrue,
    );
  });

  test('highlighting an unknown id leaves everything at rest', () async {
    await overlay.showCandidates(<RouteCandidate>[candidate()]);

    await overlay.highlight('not-a-candidate');

    expect(markers.updated.single.iconSize, 1.0);
  });

  test('never touches markers it did not create (§56)', () async {
    /* A Place marker on a manager the overlay would share if the screen had not given
       it its own. */
    final mapbox.PointAnnotation foreign = await markers.create(
      mapbox.PointAnnotationOptions(
        geometry: mapbox.Point(coordinates: mapbox.Position(0, 0)),
      ),
    );

    await overlay.showCandidates(<RouteCandidate>[candidate()]);
    await overlay.clearCandidates();

    expect(
      markers.deleted.map((mapbox.PointAnnotation a) => a.id),
      isNot(contains(foreign.id)),
    );
  });
}

/// Records what the overlay asks of the SDK.
///
/// `noSuchMethod` covers the rest of the manager surface: the overlay uses three of
/// its methods, and stubbing the others by hand would rot on every SDK upgrade.
class _StubPointManager implements mapbox.PointAnnotationManager {
  final List<mapbox.PointAnnotationOptions> created =
      <mapbox.PointAnnotationOptions>[];
  final List<mapbox.PointAnnotation> updated = <mapbox.PointAnnotation>[];
  final List<mapbox.PointAnnotation> deleted = <mapbox.PointAnnotation>[];
  int _nextId = 0;

  @override
  Future<mapbox.PointAnnotation> create(
    mapbox.PointAnnotationOptions annotation,
  ) async {
    created.add(annotation);
    return mapbox.PointAnnotation(
      id: 'point-${_nextId++}',
      geometry: annotation.geometry,
      iconSize: annotation.iconSize,
      textField: annotation.textField,
    );
  }

  @override
  Future<void> update(mapbox.PointAnnotation annotation) async {
    updated.add(annotation);
  }

  @override
  Future<void> delete(mapbox.PointAnnotation annotation) async {
    deleted.add(annotation);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

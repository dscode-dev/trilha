import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/app/theme/app_theme.dart';
import 'package:trilha_mobile/core/errors/app_failure.dart';
import 'package:trilha_mobile/features/places/domain/place.dart';
import 'package:trilha_mobile/features/places/presentation/contribute_place_screen.dart';
import 'package:trilha_mobile/features/places/presentation/place_detail_sheet.dart';
import 'package:trilha_mobile/features/places/presentation/place_search_bar.dart';
import 'package:trilha_mobile/shared/widgets/async_action_button.dart';

import '../../support/auth_fakes.dart';
import '../../support/places_fakes.dart';

/// Search, detail and contribution surfaces (§50, §48, §51, §62).
///
/// The Mapbox platform view cannot render in a test binding, so these exercise the
/// surfaces around it. The map widget itself is covered by the camera seam and by a
/// real device smoke (§63, §86).
void main() {
  /// The default 800x600 test surface is shorter than any real phone, which pushes a
  /// form's submit button off-screen. A realistic viewport keeps these tests about
  /// the form rather than about scrolling.
  void useRealisticViewport(WidgetTester tester) {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
  }

  Widget host(ProviderContainer container, Widget child) =>
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.light(),
          home: Scaffold(body: child),
        ),
      );

  group('PlaceSearchBar (§50)', () {
    testWidgets('does not query before the minimum term length', (
      WidgetTester tester,
    ) async {
      final FakePlacesApi places = FakePlacesApi();
      final ProviderContainer container = placesTestContainer(places: places);
      addTearDown(container.dispose);

      await tester.pumpWidget(
        host(container, PlaceSearchBar(onSelected: (_) {})),
      );
      await tester.enterText(find.byType(TextField), 'a');
      await tester.pump(const Duration(milliseconds: 500));

      expect(places.searchCalls, 0);
    });

    testWidgets('debounces a burst of keystrokes into one request', (
      WidgetTester tester,
    ) async {
      final FakePlacesApi places = FakePlacesApi();
      final ProviderContainer container = placesTestContainer(places: places);
      addTearDown(container.dispose);

      await tester.pumpWidget(
        host(container, PlaceSearchBar(onSelected: (_) {})),
      );

      /* A typist producing one request per character would hammer the API. */
      for (final String term in <String>['ma', 'mar', 'marc', 'marco']) {
        await tester.enterText(find.byType(TextField), term);
        await tester.pump(const Duration(milliseconds: 60));
      }
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();

      expect(places.searchCalls, 1);
      expect(places.searchTerms.single, 'marco');
    });

    testWidgets('renders results from the backend', (
      WidgetTester tester,
    ) async {
      final FakePlacesApi places = FakePlacesApi()
        ..searchResults = <PlaceListItem>[
          listItem('a', name: 'Marco Zero', distanceMetres: 850),
        ];
      final ProviderContainer container = placesTestContainer(places: places);
      addTearDown(container.dispose);

      await tester.pumpWidget(
        host(container, PlaceSearchBar(onSelected: (_) {})),
      );
      await tester.enterText(find.byType(TextField), 'marco');
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();

      expect(find.text('Marco Zero'), findsOneWidget);
      /* Distance is formatted for a person, from the server's metres (§21). */
      expect(find.textContaining('850 m'), findsOneWidget);
    });

    testWidgets('reports an empty result rather than looking broken', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = placesTestContainer(
        places: FakePlacesApi(),
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(
        host(container, PlaceSearchBar(onSelected: (_) {})),
      );
      await tester.enterText(find.byType(TextField), 'nothing here');
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();

      expect(find.textContaining('No places match'), findsOneWidget);
    });

    testWidgets('shows a human message when the network is down (§56)', (
      WidgetTester tester,
    ) async {
      final FakePlacesApi places = FakePlacesApi()
        ..searchFailure = const AppFailure(
          kind: FailureKind.networkUnavailable,
          message: 'Offline',
        );
      final ProviderContainer container = placesTestContainer(places: places);
      addTearDown(container.dispose);

      await tester.pumpWidget(
        host(container, PlaceSearchBar(onSelected: (_) {})),
      );
      await tester.enterText(find.byType(TextField), 'marco');
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();

      expect(find.text('No connection.'), findsOneWidget);
      expect(find.textContaining('DioException'), findsNothing);
      expect(find.textContaining('SocketException'), findsNothing);
    });

    testWidgets('a stale response does not replace newer results', (
      WidgetTester tester,
    ) async {
      final FakePlacesApi places = FakePlacesApi()
        ..latency = const Duration(milliseconds: 200)
        ..searchResults = <PlaceListItem>[listItem('old', name: 'Old Result')];
      final ProviderContainer container = placesTestContainer(places: places);
      addTearDown(container.dispose);

      await tester.pumpWidget(
        host(container, PlaceSearchBar(onSelected: (_) {})),
      );

      await tester.enterText(find.byType(TextField), 'first');
      await tester.pump(const Duration(milliseconds: 400));

      places.searchResults = <PlaceListItem>[
        listItem('new', name: 'New Result'),
      ];
      await tester.enterText(find.byType(TextField), 'second');
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();

      expect(find.text('New Result'), findsOneWidget);
      expect(find.text('Old Result'), findsNothing);
    });

    testWidgets('selecting a result reports it to the caller', (
      WidgetTester tester,
    ) async {
      final FakePlacesApi places = FakePlacesApi()
        ..searchResults = <PlaceListItem>[listItem('a', name: 'Marco Zero')];
      final ProviderContainer container = placesTestContainer(places: places);
      addTearDown(container.dispose);

      PlaceListItem? selected;
      await tester.pumpWidget(
        host(
          container,
          PlaceSearchBar(onSelected: (PlaceListItem p) => selected = p),
        ),
      );
      await tester.enterText(find.byType(TextField), 'marco');
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Marco Zero'));
      await tester.pumpAndSettle();

      expect(selected?.id, 'a');
    });

    testWidgets('the search field is labelled for a screen reader (§58)', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = placesTestContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(
        host(container, PlaceSearchBar(onSelected: (_) {})),
      );

      expect(find.bySemanticsLabel('Search'), findsOneWidget);
    });
  });

  group('PlaceDetailSheet (§48)', () {
    testWidgets('shows the place with its origin', (WidgetTester tester) async {
      final ProviderContainer container = placesTestContainer(
        places: FakePlacesApi(),
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(
        host(container, const PlaceDetailSheet(placeId: 'a')),
      );
      await tester.pumpAndSettle();

      expect(find.text('Marco Zero'), findsOneWidget);
      expect(
        find.textContaining('A landmark in central Recife.'),
        findsOneWidget,
      );
      /* Provenance is shown so a reader knows how much to trust the entry (§11). */
      expect(find.text('Added by the community'), findsOneWidget);
      expect(find.textContaining('Ana Souza'), findsOneWidget);
    });

    testWidgets('shows a distance only when one was supplied', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = placesTestContainer(
        places: FakePlacesApi(),
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(
        host(
          container,
          const PlaceDetailSheet(placeId: 'a', knownDistanceMetres: 1200),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('1.2 km away'), findsOneWidget);
    });

    testWidgets('omits distance when there is none', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = placesTestContainer(
        places: FakePlacesApi(),
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(
        host(container, const PlaceDetailSheet(placeId: 'a')),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('away'), findsNothing);
    });

    testWidgets('shows no rating, safety or opening hours (§48)', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = placesTestContainer(
        places: FakePlacesApi(),
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(
        host(container, const PlaceDetailSheet(placeId: 'a')),
      );
      await tester.pumpAndSettle();

      for (final String forbidden in <String>[
        'Rating',
        'Reviews',
        'Safety',
        'Open',
        'Closed',
        'Hours',
        '★',
      ]) {
        expect(
          find.textContaining(forbidden),
          findsNothing,
          reason: 'found "$forbidden"',
        );
      }
    });

    testWidgets('reports a failure in words, not a stack trace', (
      WidgetTester tester,
    ) async {
      final FakePlacesApi places = FakePlacesApi()
        ..detailFailure = const AppFailure(
          kind: FailureKind.networkUnavailable,
          message: 'Offline',
        );
      final ProviderContainer container = placesTestContainer(places: places);
      addTearDown(container.dispose);

      await tester.pumpWidget(
        host(container, const PlaceDetailSheet(placeId: 'a')),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('No connection'), findsOneWidget);
    });
  });

  group('ContributePlaceScreen (§51, §53)', () {
    Future<ProviderContainer> signedIn(
      WidgetTester tester,
      FakePlacesApi places,
    ) async {
      useRealisticViewport(tester);
      final ProviderContainer container = placesTestContainer(
        places: places,
        tokenStore: FakeTokenStore('stored-refresh-token'),
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(
        host(
          container,
          const ContributePlaceScreen(initialPosition: kMarcoZero),
        ),
      );
      await tester.pumpAndSettle();
      return container;
    }

    testWidgets('asks an unauthenticated visitor to sign in (§53)', (
      WidgetTester tester,
    ) async {
      final ProviderContainer container = placesTestContainer(
        places: FakePlacesApi(),
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(
        host(
          container,
          const ContributePlaceScreen(initialPosition: kMarcoZero),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Sign in to add a place'), findsOneWidget);
    });

    testWidgets('validates the form before calling the API', (
      WidgetTester tester,
    ) async {
      final FakePlacesApi places = FakePlacesApi();
      await signedIn(tester, places);

      await tester.ensureVisible(find.byType(AsyncActionButton));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(AsyncActionButton));
      await tester.pumpAndSettle();

      expect(find.text('Give the place a name'), findsOneWidget);
      expect(places.createCalls, 0);
    });

    testWidgets('submits the name, category and confirmed position', (
      WidgetTester tester,
    ) async {
      final FakePlacesApi places = FakePlacesApi();
      await signedIn(tester, places);

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Name'),
        'Marco Zero',
      );
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Landmark').last);
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.byType(AsyncActionButton));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(AsyncActionButton));
      await tester.pumpAndSettle();

      expect(places.createCalls, 1);
      final Map<String, Object?> sent = places.created.single;
      expect(sent['name'], 'Marco Zero');
      expect(sent['categoryId'], 'LANDMARK');
      expect(sent['latitude'], kMarcoZero.latitude);
      /* Provenance and status are never sent: the server decides them (§24). */
      expect(sent.containsKey('provenance'), isFalse);
      expect(sent.containsKey('status'), isFalse);
    });

    testWidgets(
      'surfaces near-duplicates without treating them as a rejection (§52)',
      (WidgetTester tester) async {
        final FakePlacesApi places = FakePlacesApi()
          ..duplicatesOnCreate = <PlaceListItem>[
            listItem('dup', name: 'Marco Zero', distanceMetres: 20),
          ];
        await signedIn(tester, places);

        await tester.enterText(
          find.widgetWithText(TextFormField, 'Name'),
          'Marco Zero',
        );
        await tester.tap(find.byType(DropdownButtonFormField<String>));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Landmark').last);
        await tester.pumpAndSettle();

        await tester.ensureVisible(find.byType(AsyncActionButton));
        await tester.pumpAndSettle();
        await tester.tap(find.byType(AsyncActionButton));
        /* The notice is a modal dialog awaiting dismissal, so the tree never goes
           idle; bounded pumps let it appear without waiting for a settle that
           cannot come. */
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));

        expect(find.text('Similar places nearby'), findsOneWidget);
        /* The submission still succeeded. */
        expect(places.createCalls, 1);
      },
    );

    testWidgets('reports an expired session in its own terms (§53)', (
      WidgetTester tester,
    ) async {
      final FakePlacesApi places = FakePlacesApi()
        ..createFailure = const AppFailure(
          kind: FailureKind.sessionExpired,
          message: 'Session ended',
        );
      await signedIn(tester, places);

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Name'),
        'Marco Zero',
      );
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Landmark').last);
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.byType(AsyncActionButton));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(AsyncActionButton));
      await tester.pumpAndSettle();

      expect(find.textContaining('session ended'), findsOneWidget);
    });

    testWidgets('repeated taps cannot submit twice (§46)', (
      WidgetTester tester,
    ) async {
      final FakePlacesApi places = FakePlacesApi()
        ..latency = const Duration(milliseconds: 150);
      await signedIn(tester, places);

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Name'),
        'Marco Zero',
      );
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Landmark').last);
      await tester.pumpAndSettle();

      final Finder submit = find.byType(AsyncActionButton);
      await tester.ensureVisible(submit);
      await tester.pumpAndSettle();
      await tester.tap(submit);
      await tester.pump();
      await tester.tap(submit, warnIfMissed: false);
      await tester.pumpAndSettle();

      expect(places.createCalls, 1);
    });
  });
}

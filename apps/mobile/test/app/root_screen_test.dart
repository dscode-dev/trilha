import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/app/theme/app_theme.dart';
import 'package:trilha_mobile/features/root/presentation/root_screen.dart';
import 'package:trilha_mobile/shared/widgets/trilha_logo.dart';

Widget _harness({double textScale = 1.0, Size size = const Size(390, 844)}) {
  return MaterialApp(
    theme: AppTheme.light(),
    home: MediaQuery(
      data: MediaQueryData(
        size: size,
        textScaler: TextScaler.linear(textScale),
      ),
      child: const RootScreen(),
    ),
  );
}

void main() {
  group('RootScreen', () {
    testWidgets('renders the brand asset from logo.png', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_harness());

      expect(find.byType(TrilhaLogo), findsOneWidget);

      final Image image = tester.widget<Image>(find.byType(Image));
      final AssetImage provider = image.image as AssetImage;
      expect(provider.assetName, TrilhaLogo.assetPath);
    });

    testWidgets('exposes the logo to screen readers (§23)', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_harness());

      final Image image = tester.widget<Image>(find.byType(Image));
      expect(image.semanticLabel, isNotEmpty);
    });

    testWidgets('marks the product name as a heading', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_harness());

      final SemanticsHandle handle = tester.ensureSemantics();
      expect(
        tester.getSemantics(find.text('Trilha')),
        matchesSemantics(label: 'Trilha', isHeader: true),
      );
      handle.dispose();
    });

    testWidgets('shows no fabricated product content (§22)', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_harness());

      // The root surface must not imply features that do not exist.
      for (final String forbidden in <String>[
        'Trails',
        'Places',
        'Nearby',
        'Explore',
        'Sign in',
        'km',
      ]) {
        expect(
          find.textContaining(forbidden),
          findsNothing,
          reason: 'found "$forbidden"',
        );
      }
    });

    testWidgets('does not overflow at large accessible text sizes (§23)', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_harness(textScale: 2.0));
      // The progress indicator animates indefinitely, so settling would never
      // return; a couple of frames is enough to surface a layout overflow.
      await tester.pump(const Duration(milliseconds: 100));

      expect(tester.takeException(), isNull);
    });

    testWidgets('does not overflow on a small viewport', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_harness(size: const Size(320, 568)));
      await tester.pump(const Duration(milliseconds: 100));

      expect(tester.takeException(), isNull);
    });
  });
}

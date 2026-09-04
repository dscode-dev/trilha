import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/app/config/app_config.dart';
import 'package:trilha_mobile/app/config/app_environment.dart';

void main() {
  group('AppEnvironment', () {
    test('defaults to development when no define is supplied', () {
      // The suite runs without --dart-define, which is exactly the default path.
      expect(AppEnvironment.resolve(), AppEnvironment.development);
    });

    test('exposes the three supported flavors', () {
      expect(AppEnvironment.values, <AppEnvironment>[
        AppEnvironment.development,
        AppEnvironment.staging,
        AppEnvironment.production,
      ]);
    });

    test('classifies production correctly', () {
      expect(AppEnvironment.production.isProduction, isTrue);
      expect(AppEnvironment.development.isProduction, isFalse);
      expect(AppEnvironment.staging.isProduction, isFalse);
    });
  });

  group('AppConfig', () {
    test('every flavor resolves a usable, versioned base URL', () {
      for (final AppEnvironment environment in AppEnvironment.values) {
        final AppConfig config = AppConfig.forEnvironment(environment);
        final Uri uri = Uri.parse(config.apiBaseUrl);

        expect(
          uri.hasScheme,
          isTrue,
          reason: '${environment.name} must have a scheme',
        );
        expect(
          uri.host,
          isNotEmpty,
          reason: '${environment.name} must have a host',
        );
        expect(config.apiBaseUrl, endsWith('/api/v1'));
      }
    });

    test('non-development flavors are HTTPS only', () {
      for (final AppEnvironment environment in <AppEnvironment>[
        AppEnvironment.staging,
        AppEnvironment.production,
      ]) {
        expect(
          AppConfig.forEnvironment(environment).apiBaseUrl,
          startsWith('https://'),
          reason: '${environment.name} must not send traffic in the clear',
        );
      }
    });

    test('flavors do not share an endpoint', () {
      final Set<String> urls = AppEnvironment.values
          .map((e) => AppConfig.forEnvironment(e).apiBaseUrl)
          .toSet();

      expect(urls.length, AppEnvironment.values.length);
    });

    test('declares non-zero timeouts', () {
      final AppConfig config = AppConfig.forEnvironment(
        AppEnvironment.development,
      );

      expect(config.connectTimeout, greaterThan(Duration.zero));
      expect(config.receiveTimeout, greaterThan(Duration.zero));
    });

    test('compares by value', () {
      expect(
        AppConfig.forEnvironment(AppEnvironment.production),
        AppConfig.forEnvironment(AppEnvironment.production),
      );
      expect(
        AppConfig.forEnvironment(AppEnvironment.production),
        isNot(AppConfig.forEnvironment(AppEnvironment.staging)),
      );
    });
  });
}

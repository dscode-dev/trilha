import 'package:equatable/equatable.dart';

import 'app_environment.dart';

/// Resolved, immutable client configuration.
///
/// Built once during bootstrap and provided through Riverpod. Widgets never read
/// build-time defines directly, so swapping an endpoint touches exactly one place.
class AppConfig extends Equatable {
  const AppConfig({
    required this.environment,
    required this.apiBaseUrl,
    required this.connectTimeout,
    required this.receiveTimeout,
  });

  /// Builds configuration for [environment], allowing the API host to be
  /// overridden at build time (useful for device testing against a laptop).
  factory AppConfig.forEnvironment(AppEnvironment environment) {
    const override = String.fromEnvironment('TRILHA_API_BASE_URL');

    return AppConfig(
      environment: environment,
      apiBaseUrl: override.isNotEmpty ? override : _defaultBaseUrl(environment),
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 20),
    );
  }

  final AppEnvironment environment;
  final String apiBaseUrl;
  final Duration connectTimeout;
  final Duration receiveTimeout;

  static String _defaultBaseUrl(AppEnvironment environment) {
    switch (environment) {
      case AppEnvironment.development:
        // Android emulators reach the host loopback through 10.0.2.2; override
        // TRILHA_API_BASE_URL when running on a physical device.
        return 'http://localhost:3000/api/v1';
      case AppEnvironment.staging:
        return 'https://staging.api.trilha.app/api/v1';
      case AppEnvironment.production:
        return 'https://api.trilha.app/api/v1';
    }
  }

  @override
  List<Object?> get props => [
    environment,
    apiBaseUrl,
    connectTimeout,
    receiveTimeout,
  ];
}

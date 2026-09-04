/// Build-time environment selection (§19).
///
/// The flavor is chosen with `--dart-define=TRILHA_ENV=...` so a build artefact is
/// unambiguously tied to one environment. Nothing sensitive is compiled in: only
/// the endpoint the client should talk to.
enum AppEnvironment {
  development,
  staging,
  production;

  static const String _key = 'TRILHA_ENV';

  /// Resolves the flavor from the compile-time define, defaulting to development
  /// so a plain `flutter run` works without ceremony.
  static AppEnvironment resolve() {
    const raw = String.fromEnvironment(_key, defaultValue: 'development');
    return AppEnvironment.values.firstWhere(
      (environment) => environment.name == raw,
      orElse: () => throw ArgumentError.value(
        raw,
        _key,
        'Unknown environment. Expected one of: '
        '${AppEnvironment.values.map((e) => e.name).join(', ')}',
      ),
    );
  }

  bool get isProduction => this == AppEnvironment.production;
  bool get isDevelopment => this == AppEnvironment.development;
}

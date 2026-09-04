/// Mapbox configuration (§37).
///
/// The access token is supplied at build time and never committed:
///
///   flutter run --dart-define=MAPBOX_ACCESS_TOKEN=pk.xxxxx
///
/// A Mapbox *public* token (`pk.`) is designed to ship inside a client — it is
/// visible in any built app, by anyone. That is why it must be URL-restricted in the
/// Mapbox dashboard, and why a *secret* token (`sk.`) must never appear here: those
/// grant account access and belong only in a build machine's environment.
abstract final class MapConfig {
  const MapConfig._();

  static const String accessToken = String.fromEnvironment(
    'MAPBOX_ACCESS_TOKEN',
  );

  /// Whether the map can initialise at all. The UI explains itself when false
  /// rather than rendering a blank rectangle (§86).
  static bool get hasAccessToken => accessToken.isNotEmpty;

  /// A public token starts with `pk.`; a secret one with `sk.`. Shipping a secret
  /// token would leak account credentials to every installed copy of the app.
  static bool get tokenLooksSecret => accessToken.startsWith('sk.');

  /// Opening view when there is no stored position and no permission: central
  /// Recife, where Trilha starts.
  static const double defaultLatitude = -8.0631;
  static const double defaultLongitude = -34.8711;
  static const double defaultZoom = 13;

  /// Zoom applied when recentring on the user or a search result.
  static const double focusedZoom = 15;
}

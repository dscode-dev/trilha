import 'package:geolocator/geolocator.dart';

/// Where the app stands with the device's location (§40).
enum LocationAvailability {
  /// Not asked yet — the map opens without prompting.
  notRequested,
  granted,
  denied,

  /// Denied permanently; only Settings can change it.
  deniedForever,

  /// Location services are switched off device-wide.
  serviceDisabled,
}

/// Foreground location access.
///
/// **Privacy (§42).** Position is read on demand, used to move the camera, and
/// discarded. It is never persisted, never sent to Trilha's servers, and background
/// location is never requested — the app has no use for the user's whereabouts when
/// it is not open, so it does not ask.
abstract interface class LocationService {
  Future<LocationAvailability> currentPermission();
  Future<LocationAvailability> request();

  /// The current position, or null when unavailable. Never throws for a denied
  /// permission — that is an expected state, not an error.
  Future<({double latitude, double longitude})?> currentPosition();
}

class GeolocatorLocationService implements LocationService {
  const GeolocatorLocationService();

  /// A device indoors can take a long time to fix. The map stays usable meanwhile,
  /// so the wait is bounded rather than indefinite.
  static const Duration _timeout = Duration(seconds: 10);

  @override
  Future<LocationAvailability> currentPermission() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      return LocationAvailability.serviceDisabled;
    }
    return _map(await Geolocator.checkPermission());
  }

  @override
  Future<LocationAvailability> request() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      return LocationAvailability.serviceDisabled;
    }
    return _map(await Geolocator.requestPermission());
  }

  @override
  Future<({double latitude, double longitude})?> currentPosition() async {
    final LocationAvailability availability = await currentPermission();
    if (availability != LocationAvailability.granted) return null;

    try {
      final Position position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: _timeout,
        ),
      );
      return (latitude: position.latitude, longitude: position.longitude);
    } on Object {
      // A timeout or a platform error means "no fix right now", which the map
      // handles by simply not recentring. It is not a failure to surface.
      return null;
    }
  }

  static LocationAvailability _map(LocationPermission permission) =>
      switch (permission) {
        LocationPermission.always ||
        LocationPermission.whileInUse => LocationAvailability.granted,
        LocationPermission.denied => LocationAvailability.denied,
        LocationPermission.deniedForever => LocationAvailability.deniedForever,
        LocationPermission.unableToDetermine =>
          LocationAvailability.notRequested,
      };
}

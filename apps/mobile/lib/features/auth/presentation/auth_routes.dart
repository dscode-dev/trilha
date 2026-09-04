/// Route identifiers for the auth and profile surfaces.
abstract final class AuthRoutes {
  const AuthRoutes._();

  static const String loginPath = '/sign-in';
  static const String loginName = 'sign-in';

  static const String registerPath = '/sign-up';
  static const String registerName = 'sign-up';

  /// The map is the product's root surface (§38), not a dashboard.
  static const String homePath = '/map';
  static const String homeName = 'map';

  static const String profilePath = '/profile';
  static const String profileName = 'profile';

  static const String changePasswordPath = '/profile/password';
  static const String changePasswordName = 'change-password';
}

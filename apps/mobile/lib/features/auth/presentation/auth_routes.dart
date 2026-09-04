/// Route identifiers for the auth and profile surfaces.
abstract final class AuthRoutes {
  const AuthRoutes._();

  static const String loginPath = '/sign-in';
  static const String loginName = 'sign-in';

  static const String registerPath = '/sign-up';
  static const String registerName = 'sign-up';

  static const String homePath = '/home';
  static const String homeName = 'home';

  static const String profilePath = '/profile';
  static const String profileName = 'profile';

  static const String changePasswordPath = '/profile/password';
  static const String changePasswordName = 'change-password';
}

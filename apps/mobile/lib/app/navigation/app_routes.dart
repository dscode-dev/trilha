/// Route identifiers, kept in one place so deep links and navigation calls cannot
/// drift apart through stringly-typed duplication (§17).
abstract final class AppRoutes {
  const AppRoutes._();

  static const String rootPath = '/';
  static const String rootName = 'root';
}

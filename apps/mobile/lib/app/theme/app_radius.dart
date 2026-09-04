import 'package:flutter/widgets.dart';

/// Corner radius scale (§21).
///
/// The logo's pin is a soft, rounded form; the ramp stays generous to match it
/// rather than adopting Material's sharper defaults.
abstract final class AppRadius {
  const AppRadius._();

  static const Radius sm = Radius.circular(8);
  static const Radius md = Radius.circular(12);
  static const Radius lg = Radius.circular(20);
  static const Radius pill = Radius.circular(999);

  static const BorderRadius allSm = BorderRadius.all(sm);
  static const BorderRadius allMd = BorderRadius.all(md);
  static const BorderRadius allLg = BorderRadius.all(lg);
  static const BorderRadius allPill = BorderRadius.all(pill);
}

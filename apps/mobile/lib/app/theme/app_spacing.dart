/// Spacing scale (§21).
///
/// A single 4dp-based ramp. Screens compose these constants instead of inventing
/// one-off paddings, which is what keeps unrelated features visually consistent.
abstract final class AppSpacing {
  const AppSpacing._();

  static const double xs = 4;
  static const double sm = 8;
  static const double md = 16;
  static const double lg = 24;
  static const double xl = 32;
  static const double xxl = 48;

  /// Minimum interactive target. Matches the larger of the iOS (44) and
  /// Material (48) guidance so touch targets pass on both platforms (§23).
  static const double minTouchTarget = 48;
}

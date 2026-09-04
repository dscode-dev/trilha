import 'package:flutter/material.dart';

import '../../app/theme/app_spacing.dart';

/// A primary button that cannot be fired twice (§46).
///
/// While [onPressed] is running the button is disabled and shows a spinner, so
/// repeated taps cannot start a second registration, login or password change. The
/// guard lives here rather than in each screen because every screen would otherwise
/// have to remember it.
class AsyncActionButton extends StatelessWidget {
  const AsyncActionButton({
    required this.label,
    required this.onPressed,
    required this.isBusy,
    super.key,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool isBusy;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      // The label is declared here, so it survives the swap to a spinner: a screen
      // reader must still be able to say what the button does while it is working.
      label: label,
      button: true,
      enabled: !isBusy && onPressed != null,
      child: SizedBox(
        width: double.infinity,
        child: FilledButton(
          onPressed: isBusy ? null : onPressed,
          child: isBusy
              ? const SizedBox(
                  height: AppSpacing.md,
                  width: AppSpacing.md,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Text(label),
        ),
      ),
    );
  }
}

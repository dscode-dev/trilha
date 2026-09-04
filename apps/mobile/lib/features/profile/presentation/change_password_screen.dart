import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/theme/app_spacing.dart';
import '../../../shared/widgets/async_action_button.dart';
import '../../../shared/widgets/form_error_banner.dart';
import '../../auth/application/auth_providers.dart';
import '../../auth/domain/auth_failure.dart';
import '../../auth/presentation/auth_form_messages.dart';
import '../../auth/presentation/auth_routes.dart';
import '../../auth/presentation/auth_validators.dart';

/// Password change (§24, §43).
///
/// The server revokes every session on success, this one included, so the screen
/// tells the user that up front rather than letting them discover it by being
/// bounced to sign-in.
class ChangePasswordScreen extends ConsumerStatefulWidget {
  const ChangePasswordScreen({super.key});

  @override
  ConsumerState<ChangePasswordScreen> createState() =>
      _ChangePasswordScreenState();
}

class _ChangePasswordScreenState extends ConsumerState<ChangePasswordScreen> {
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
  final TextEditingController _current = TextEditingController();
  final TextEditingController _next = TextEditingController();
  final TextEditingController _confirm = TextEditingController();

  bool _isSubmitting = false;
  bool _obscure = true;
  String? _error;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_isSubmitting) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;

    setState(() {
      _isSubmitting = true;
      _error = null;
    });

    try {
      await ref
          .read(authControllerProvider.notifier)
          .changePassword(
            currentPassword: _current.text,
            newPassword: _next.text,
          );
      // Success clears the session; the router sends us to sign-in (§36).
    } on Object catch (error) {
      if (!mounted) return;
      setState(
        () => _error = AuthFormMessages.forFailure(AuthFailure.from(error)),
      );
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Change password'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          tooltip: 'Back',
          onPressed: _isSubmitting
              ? null
              : () => context.goNamed(AuthRoutes.profileName),
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    FormErrorBanner(message: _error),

                    Text(
                      'For your security, changing your password signs you out on '
                      'every device. You will sign in again with the new one.',
                      style: theme.textTheme.bodyMedium,
                    ),
                    const SizedBox(height: AppSpacing.lg),

                    TextFormField(
                      controller: _current,
                      decoration: const InputDecoration(
                        labelText: 'Current password',
                      ),
                      obscureText: _obscure,
                      textInputAction: TextInputAction.next,
                      enabled: !_isSubmitting,
                      validator: AuthValidators.loginPassword,
                    ),
                    const SizedBox(height: AppSpacing.md),

                    TextFormField(
                      controller: _next,
                      decoration: InputDecoration(
                        labelText: 'New password',
                        helperText:
                            'At least ${AuthValidators.passwordMinLength} characters',
                        suffixIcon: IconButton(
                          icon: Icon(
                            _obscure
                                ? Icons.visibility_outlined
                                : Icons.visibility_off_outlined,
                          ),
                          tooltip: _obscure
                              ? 'Show passwords'
                              : 'Hide passwords',
                          onPressed: () => setState(() => _obscure = !_obscure),
                        ),
                      ),
                      obscureText: _obscure,
                      textInputAction: TextInputAction.next,
                      autofillHints: const <String>[AutofillHints.newPassword],
                      enabled: !_isSubmitting,
                      validator: (String? value) {
                        final String? policy = AuthValidators.password(value);
                        if (policy != null) return policy;
                        if (value == _current.text) {
                          return 'Choose a password different from the current one';
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: AppSpacing.md),

                    TextFormField(
                      controller: _confirm,
                      decoration: const InputDecoration(
                        labelText: 'Confirm new password',
                      ),
                      obscureText: _obscure,
                      textInputAction: TextInputAction.done,
                      enabled: !_isSubmitting,
                      validator: (String? value) =>
                          value == _next.text ? null : 'Passwords do not match',
                      onFieldSubmitted: (_) => unawaited(_submit()),
                    ),
                    const SizedBox(height: AppSpacing.lg),

                    AsyncActionButton(
                      label: 'Change password',
                      isBusy: _isSubmitting,
                      onPressed: () => unawaited(_submit()),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/theme/app_spacing.dart';
import '../../../shared/widgets/async_action_button.dart';
import '../../../shared/widgets/form_error_banner.dart';
import '../../../shared/widgets/trilha_logo.dart';
import '../application/auth_providers.dart';
import '../../../core/errors/app_failure.dart';
import 'auth_form_messages.dart';
import 'auth_routes.dart';
import 'auth_validators.dart';

/// Registration surface (§42).
///
/// Local validation catches shape errors; availability is never guessed at. The
/// server is the only authority on whether an email or username is free, and its
/// answer is attached to the field it concerns.
class SignUpScreen extends ConsumerStatefulWidget {
  const SignUpScreen({super.key});

  @override
  ConsumerState<SignUpScreen> createState() => _SignUpScreenState();
}

class _SignUpScreenState extends ConsumerState<SignUpScreen> {
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
  final TextEditingController _displayName = TextEditingController();
  final TextEditingController _username = TextEditingController();
  final TextEditingController _email = TextEditingController();
  final TextEditingController _password = TextEditingController();

  bool _isSubmitting = false;
  bool _obscurePassword = true;
  String? _error;

  /// Conflicts reported by the server, shown on the offending field rather than
  /// only in the banner.
  String? _emailConflict;
  String? _usernameConflict;

  @override
  void dispose() {
    _displayName.dispose();
    _username.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_isSubmitting) return;

    setState(() {
      _emailConflict = null;
      _usernameConflict = null;
    });
    if (!(_formKey.currentState?.validate() ?? false)) return;

    setState(() {
      _isSubmitting = true;
      _error = null;
    });

    try {
      await ref
          .read(authControllerProvider.notifier)
          .register(
            email: _email.text.trim(),
            password: _password.text,
            username: _username.text.trim(),
            displayName: _displayName.text.trim(),
          );
    } on Object catch (error) {
      if (!mounted) return;
      final AppFailure failure = AppFailure.from(error);

      setState(() {
        _error = AuthFormMessages.forFailure(failure);
        if (failure.kind == FailureKind.emailAlreadyInUse) {
          _emailConflict = 'That email is already registered';
        }
        if (failure.kind == FailureKind.usernameAlreadyInUse) {
          _usernameConflict = 'That username is taken';
        }
      });
      // Re-run validation so the field-level conflicts render immediately.
      _formKey.currentState?.validate();
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  void _submitPressed() {
    unawaited(_submit());
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Create your account')),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.lg,
              vertical: AppSpacing.lg,
            ),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    const TrilhaLogo(size: 72),
                    const SizedBox(height: AppSpacing.lg),

                    FormErrorBanner(message: _error),

                    TextFormField(
                      controller: _displayName,
                      decoration: const InputDecoration(
                        labelText: 'Name',
                        prefixIcon: Icon(Icons.person_outline),
                      ),
                      textInputAction: TextInputAction.next,
                      autofillHints: const <String>[AutofillHints.name],
                      enabled: !_isSubmitting,
                      validator: AuthValidators.displayName,
                    ),
                    const SizedBox(height: AppSpacing.md),

                    TextFormField(
                      controller: _username,
                      decoration: const InputDecoration(
                        labelText: 'Username',
                        prefixIcon: Icon(Icons.alternate_email),
                        helperText: 'Letters and numbers, separated by - or _',
                      ),
                      textInputAction: TextInputAction.next,
                      autocorrect: false,
                      enabled: !_isSubmitting,
                      validator: (String? value) =>
                          _usernameConflict ?? AuthValidators.username(value),
                    ),
                    const SizedBox(height: AppSpacing.md),

                    TextFormField(
                      controller: _email,
                      decoration: const InputDecoration(
                        labelText: 'Email',
                        prefixIcon: Icon(Icons.mail_outline),
                      ),
                      keyboardType: TextInputType.emailAddress,
                      textInputAction: TextInputAction.next,
                      autocorrect: false,
                      autofillHints: const <String>[AutofillHints.email],
                      enabled: !_isSubmitting,
                      validator: (String? value) =>
                          _emailConflict ?? AuthValidators.email(value),
                    ),
                    const SizedBox(height: AppSpacing.md),

                    TextFormField(
                      controller: _password,
                      decoration: InputDecoration(
                        labelText: 'Password',
                        prefixIcon: const Icon(Icons.lock_outline),
                        helperText:
                            'At least ${AuthValidators.passwordMinLength} characters. '
                            'A short sentence works well.',
                        helperMaxLines: 2,
                        suffixIcon: IconButton(
                          icon: Icon(
                            _obscurePassword
                                ? Icons.visibility_outlined
                                : Icons.visibility_off_outlined,
                          ),
                          tooltip: _obscurePassword
                              ? 'Show password'
                              : 'Hide password',
                          onPressed: () => setState(
                            () => _obscurePassword = !_obscurePassword,
                          ),
                        ),
                      ),
                      obscureText: _obscurePassword,
                      textInputAction: TextInputAction.done,
                      autofillHints: const <String>[AutofillHints.newPassword],
                      enabled: !_isSubmitting,
                      validator: AuthValidators.password,
                      onFieldSubmitted: (_) => _submitPressed(),
                    ),
                    const SizedBox(height: AppSpacing.lg),

                    AsyncActionButton(
                      label: 'Create account',
                      isBusy: _isSubmitting,
                      onPressed: _submitPressed,
                    ),
                    const SizedBox(height: AppSpacing.sm),

                    TextButton(
                      onPressed: _isSubmitting
                          ? null
                          : () => context.goNamed(AuthRoutes.loginName),
                      child: const Text('Already have an account? Sign in'),
                    ),
                    const SizedBox(height: AppSpacing.md),

                    Text(
                      'Trilha stores only what an account needs: your name, username '
                      'and email.',
                      style: theme.textTheme.bodyMedium,
                      textAlign: TextAlign.center,
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

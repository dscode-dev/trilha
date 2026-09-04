import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/theme/app_spacing.dart';
import '../../../shared/widgets/async_action_button.dart';
import '../../../shared/widgets/form_error_banner.dart';
import '../../../shared/widgets/trilha_logo.dart';
import '../application/auth_providers.dart';
import '../domain/auth_failure.dart';
import 'auth_form_messages.dart';
import 'auth_routes.dart';
import 'auth_validators.dart';

/// Sign-in surface (§41).
///
/// Covers the states the brief requires: idle, validating, submitting, server
/// failure, throttled and offline — each surfaced as a sentence, never as a code.
class SignInScreen extends ConsumerStatefulWidget {
  const SignInScreen({super.key});

  @override
  ConsumerState<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends ConsumerState<SignInScreen> {
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
  final TextEditingController _email = TextEditingController();
  final TextEditingController _password = TextEditingController();

  bool _isSubmitting = false;
  bool _obscurePassword = true;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    // Guards against a second submission if a tap lands during the await (§46).
    if (_isSubmitting) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;

    setState(() {
      _isSubmitting = true;
      _error = null;
    });

    try {
      await ref
          .read(authControllerProvider.notifier)
          .login(email: _email.text.trim(), password: _password.text);
      // On success the router reacts to the auth state; no manual navigation (§36).
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
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.lg,
              vertical: AppSpacing.xl,
            ),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    const TrilhaLogo(size: 96),
                    const SizedBox(height: AppSpacing.lg),
                    Semantics(
                      header: true,
                      child: Text(
                        'Welcome back',
                        style: theme.textTheme.headlineMedium,
                        textAlign: TextAlign.center,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.xl),

                    FormErrorBanner(message: _error),

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
                      validator: AuthValidators.email,
                    ),
                    const SizedBox(height: AppSpacing.md),

                    TextFormField(
                      controller: _password,
                      decoration: InputDecoration(
                        labelText: 'Password',
                        prefixIcon: const Icon(Icons.lock_outline),
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
                      autofillHints: const <String>[AutofillHints.password],
                      enabled: !_isSubmitting,
                      validator: AuthValidators.loginPassword,
                      onFieldSubmitted: (_) => _submitPressed(),
                    ),
                    const SizedBox(height: AppSpacing.lg),

                    AsyncActionButton(
                      label: 'Sign in',
                      isBusy: _isSubmitting,
                      onPressed: _submitPressed,
                    ),
                    const SizedBox(height: AppSpacing.md),

                    TextButton(
                      onPressed: _isSubmitting
                          ? null
                          : () => context.goNamed(AuthRoutes.registerName),
                      child: const Text('New to Trilha? Create an account'),
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

  /// `onPressed` is synchronous, so the future is explicitly unawaited. Failures are
  /// captured inside [_submit] and rendered, never dropped silently (§20).
  void _submitPressed() {
    unawaited(_submit());
  }
}

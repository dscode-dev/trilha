import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/theme/app_spacing.dart';
import '../../../shared/widgets/async_action_button.dart';
import '../../../shared/widgets/form_error_banner.dart';
import '../../../shared/widgets/initials_avatar.dart';
import '../../auth/application/auth_providers.dart';
import '../../auth/domain/account.dart';
import '../../auth/domain/auth_failure.dart';
import '../../auth/presentation/auth_form_messages.dart';
import '../../auth/presentation/auth_routes.dart';
import '../../auth/presentation/auth_validators.dart';

/// Profile surface (§43).
///
/// Shows the account, allows editing the three V1 fields, and offers the session
/// controls. No statistics, badges, followers or fabricated trails — none of those
/// exist, and showing placeholders would imply they do.
class ProfileScreen extends ConsumerStatefulWidget {
  const ProfileScreen({super.key});

  @override
  ConsumerState<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends ConsumerState<ProfileScreen> {
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
  late final TextEditingController _displayName;
  late final TextEditingController _username;
  late final TextEditingController _bio;

  bool _isSaving = false;
  bool _isSigningOut = false;
  String? _error;
  String? _usernameConflict;

  @override
  void initState() {
    super.initState();
    final Account? account = ref.read(currentAccountProvider);
    _displayName = TextEditingController(text: account?.displayName ?? '');
    _username = TextEditingController(text: account?.username ?? '');
    _bio = TextEditingController(text: account?.bio ?? '');
  }

  @override
  void dispose() {
    _displayName.dispose();
    _username.dispose();
    _bio.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_isSaving) return;
    setState(() => _usernameConflict = null);
    if (!(_formKey.currentState?.validate() ?? false)) return;

    setState(() {
      _isSaving = true;
      _error = null;
    });

    try {
      final String bio = _bio.text.trim();
      await ref
          .read(authControllerProvider.notifier)
          .updateProfile(
            displayName: _displayName.text.trim(),
            username: _username.text.trim(),
            // An empty field clears the bio rather than storing an empty string.
            bio: bio.isEmpty ? null : bio,
          );

      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Profile updated')));
    } on Object catch (error) {
      if (!mounted) return;
      final AuthFailure failure = AuthFailure.from(error);
      setState(() {
        _error = AuthFormMessages.forFailure(failure);
        if (failure.kind == AuthFailureKind.usernameAlreadyInUse) {
          _usernameConflict = 'That username is taken';
        }
      });
      _formKey.currentState?.validate();
    } finally {
      if (mounted) setState(() => _isSaving = false);
    }
  }

  Future<void> _signOut({required bool everywhere}) async {
    if (_isSigningOut) return;
    setState(() => _isSigningOut = true);

    try {
      final controller = ref.read(authControllerProvider.notifier);
      // The router reacts to the state change; no manual navigation (§36).
      await (everywhere ? controller.logoutEverywhere() : controller.logout());
    } finally {
      if (mounted) setState(() => _isSigningOut = false);
    }
  }

  Future<void> _confirmSignOutEverywhere() async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('Sign out everywhere?'),
        content: const Text(
          'This ends your session on every device, including this one. '
          'You will need to sign in again.',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Sign out everywhere'),
          ),
        ],
      ),
    );

    if (confirmed ?? false) {
      await _signOut(everywhere: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final Account? account = ref.watch(currentAccountProvider);

    if (account == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Your profile'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          tooltip: 'Back',
          onPressed: () => context.goNamed(AuthRoutes.homeName),
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Center(
                    child: InitialsAvatar(
                      initials: account.initials,
                      seed: account.username,
                      radius: 40,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.md),
                  Center(
                    child: Text(
                      account.email,
                      style: theme.textTheme.bodyMedium,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xl),

                  FormErrorBanner(message: _error),

                  Form(
                    key: _formKey,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        TextFormField(
                          controller: _displayName,
                          decoration: const InputDecoration(labelText: 'Name'),
                          enabled: !_isSaving,
                          validator: AuthValidators.displayName,
                        ),
                        const SizedBox(height: AppSpacing.md),
                        TextFormField(
                          controller: _username,
                          decoration: const InputDecoration(
                            labelText: 'Username',
                            prefixText: '@',
                          ),
                          autocorrect: false,
                          enabled: !_isSaving,
                          validator: (String? value) =>
                              _usernameConflict ??
                              AuthValidators.username(value),
                        ),
                        const SizedBox(height: AppSpacing.md),
                        TextFormField(
                          controller: _bio,
                          decoration: const InputDecoration(
                            labelText: 'Bio',
                            helperText: 'Optional',
                          ),
                          maxLines: 3,
                          maxLength: 280,
                          enabled: !_isSaving,
                        ),
                        const SizedBox(height: AppSpacing.md),
                        AsyncActionButton(
                          label: 'Save changes',
                          isBusy: _isSaving,
                          onPressed: () => unawaited(_save()),
                        ),
                      ],
                    ),
                  ),

                  const SizedBox(height: AppSpacing.xl),
                  const Divider(),
                  const SizedBox(height: AppSpacing.sm),

                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.key_outlined),
                    title: const Text('Change password'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: _isSigningOut
                        ? null
                        : () => context.goNamed(AuthRoutes.changePasswordName),
                  ),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.logout),
                    title: const Text('Sign out'),
                    onTap: _isSigningOut
                        ? null
                        : () => unawaited(_signOut(everywhere: false)),
                  ),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(
                      Icons.devices_outlined,
                      color: theme.colorScheme.error,
                    ),
                    title: Text(
                      'Sign out everywhere',
                      style: TextStyle(color: theme.colorScheme.error),
                    ),
                    subtitle: const Text(
                      'Ends every session, including this one',
                    ),
                    onTap: _isSigningOut
                        ? null
                        : () => unawaited(_confirmSignOutEverywhere()),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

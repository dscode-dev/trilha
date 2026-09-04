import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'navigation/app_router.dart';
import 'theme/app_theme.dart';

/// Root widget: wires router and theme, and nothing else.
///
/// Business rules never live in a widget (constitution §Architecture), and that
/// starts here.
class TrilhaApp extends ConsumerWidget {
  const TrilhaApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      title: 'Trilha',
      debugShowCheckedModeBanner: false,
      routerConfig: ref.watch(appRouterProvider),
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      // Follow the device preference; an in-app override belongs to a settings PR.
      themeMode: ThemeMode.system,
    );
  }
}

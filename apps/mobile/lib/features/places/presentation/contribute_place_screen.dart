import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart' as mapbox;

import '../../../app/config/map_config.dart';
import '../../../app/theme/app_radius.dart';
import '../../../app/theme/app_spacing.dart';
import '../../../core/errors/app_failure.dart';
import '../../../shared/widgets/async_action_button.dart';
import '../../../shared/widgets/form_error_banner.dart';
import '../../auth/application/auth_providers.dart';
import '../../auth/application/auth_state.dart';
import '../../auth/presentation/auth_routes.dart';
import '../application/places_providers.dart';
import '../data/places_api.dart';
import '../domain/place.dart';
import 'place_category_visuals.dart';

/// Community contribution (§51).
///
/// The location is confirmed on a real map before anything is submitted: a place
/// pinned by typing coordinates would be guesswork, so the user drags the map under
/// a fixed centre marker until it sits where they mean.
class ContributePlaceScreen extends ConsumerStatefulWidget {
  const ContributePlaceScreen({required this.initialPosition, super.key});

  final LatLng initialPosition;

  @override
  ConsumerState<ContributePlaceScreen> createState() =>
      _ContributePlaceScreenState();
}

class _ContributePlaceScreenState extends ConsumerState<ContributePlaceScreen> {
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
  final TextEditingController _name = TextEditingController();
  final TextEditingController _description = TextEditingController();

  late LatLng _position = widget.initialPosition;
  String? _categoryId;
  bool _isSubmitting = false;
  String? _error;
  List<PlaceListItem> _possibleDuplicates = const <PlaceListItem>[];

  @override
  void dispose() {
    _name.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_isSubmitting) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;

    final String? categoryId = _categoryId;
    if (categoryId == null) {
      setState(() => _error = 'Choose a category.');
      return;
    }

    setState(() {
      _isSubmitting = true;
      _error = null;
    });

    try {
      final CreatePlaceResult result = await ref
          .read(placesApiProvider)
          .create(
            name: _name.text.trim(),
            categoryId: categoryId,
            position: _position,
            description: _description.text.trim().isEmpty
                ? null
                : _description.text.trim(),
          );

      if (!mounted) return;

      /* Advisory, never a rejection: the place was created. The user is told what
         looks similar so they can decide whether to keep or report it (§52). */
      if (result.possibleDuplicates.isNotEmpty) {
        setState(() => _possibleDuplicates = result.possibleDuplicates);
        await _showDuplicateNotice(result.possibleDuplicates);
      }

      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('${result.place.name} added')));
    } on Object catch (error) {
      if (!mounted) return;
      final AppFailure failure = AppFailure.from(error);

      /* A session that expired between opening the form and submitting must not
         look like a validation problem (§53). */
      if (failure.kind == FailureKind.sessionExpired) {
        setState(() => _error = 'Your session ended. Please sign in again.');
        return;
      }

      setState(() {
        _error = switch (failure.kind) {
          FailureKind.networkUnavailable =>
            'No connection. Check your network and try again.',
          FailureKind.rateLimited =>
            'Too many submissions. Please wait a moment.',
          FailureKind.validation => 'Please check the highlighted fields.',
          _ => 'Could not add this place. Please try again.',
        };
      });
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  Future<void> _showDuplicateNotice(List<PlaceListItem> duplicates) async {
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('Similar places nearby'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Text(
              'Your place was added. These look similar and are close by:',
            ),
            const SizedBox(height: AppSpacing.sm),
            ...duplicates.map(
              (PlaceListItem d) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Text(
                  d.distanceMetres == null
                      ? '• ${d.name}'
                      : '• ${d.name} (${formatDistance(d.distanceMetres!)})',
                ),
              ),
            ),
          ],
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Got it'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final AuthState auth = ref.watch(authControllerProvider);

    /* Reading the map needs no account; contributing does (§33, §53). */
    if (!auth.isAuthenticated) return const _SignInRequired();

    final AsyncValue<List<PlaceCategory>> categories = ref.watch(
      placeCategoriesProvider,
    );

    return Scaffold(
      appBar: AppBar(title: const Text('Add a place')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.lg),
          children: <Widget>[
            Text(
              'Drag the map so the marker sits on the place.',
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: AppSpacing.sm),
            _LocationPicker(
              initial: widget.initialPosition,
              onMoved: (LatLng position) => _position = position,
            ),
            const SizedBox(height: AppSpacing.lg),

            FormErrorBanner(message: _error),

            Form(
              key: _formKey,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  TextFormField(
                    controller: _name,
                    decoration: const InputDecoration(labelText: 'Name'),
                    textInputAction: TextInputAction.next,
                    maxLength: 120,
                    enabled: !_isSubmitting,
                    validator: (String? value) {
                      final String text = (value ?? '').trim();
                      if (text.isEmpty) return 'Give the place a name';
                      return null;
                    },
                  ),
                  const SizedBox(height: AppSpacing.sm),

                  categories.when(
                    loading: () => const LinearProgressIndicator(),
                    error: (_, _) =>
                        const Text('Categories are unavailable right now.'),
                    data: (List<PlaceCategory> options) =>
                        DropdownButtonFormField<String>(
                          initialValue: _categoryId,
                          decoration: const InputDecoration(
                            labelText: 'Category',
                          ),
                          items: options
                              .map(
                                (PlaceCategory c) => DropdownMenuItem<String>(
                                  value: c.id,
                                  child: Row(
                                    children: <Widget>[
                                      Icon(
                                        PlaceCategoryVisuals.iconFor(c.id),
                                        size: 18,
                                      ),
                                      const SizedBox(width: AppSpacing.sm),
                                      Text(c.label),
                                    ],
                                  ),
                                ),
                              )
                              .toList(),
                          onChanged: _isSubmitting
                              ? null
                              : (String? value) =>
                                    setState(() => _categoryId = value),
                          validator: (String? value) =>
                              value == null ? 'Choose a category' : null,
                        ),
                  ),
                  const SizedBox(height: AppSpacing.sm),

                  TextFormField(
                    controller: _description,
                    decoration: const InputDecoration(
                      labelText: 'Description',
                      helperText: 'Optional',
                    ),
                    maxLines: 3,
                    maxLength: 1000,
                    enabled: !_isSubmitting,
                  ),
                  const SizedBox(height: AppSpacing.md),

                  AsyncActionButton(
                    label: 'Add place',
                    isBusy: _isSubmitting,
                    onPressed: () => unawaited(_submit()),
                  ),
                ],
              ),
            ),

            if (_possibleDuplicates.isNotEmpty) ...<Widget>[
              const SizedBox(height: AppSpacing.md),
              Text(
                'Similar places nearby: '
                '${_possibleDuplicates.map((PlaceListItem d) => d.name).join(', ')}',
                style: theme.textTheme.bodyMedium,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// A small map with a fixed centre marker; dragging moves the location under it.
class _LocationPicker extends StatefulWidget {
  const _LocationPicker({required this.initial, required this.onMoved});

  final LatLng initial;
  final void Function(LatLng) onMoved;

  @override
  State<_LocationPicker> createState() => _LocationPickerState();
}

class _LocationPickerState extends State<_LocationPicker> {
  mapbox.MapboxMap? _map;

  Future<void> _reportCentre(mapbox.MapIdleEventData _) async {
    final mapbox.MapboxMap? map = _map;
    if (map == null) return;

    final mapbox.CameraState camera = await map.getCameraState();
    widget.onMoved(
      LatLng(
        latitude: camera.center.coordinates.lat.toDouble(),
        longitude: camera.center.coordinates.lng.toDouble(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!MapConfig.hasAccessToken) {
      return const SizedBox(
        height: 200,
        child: Center(child: Text('The map needs a Mapbox token.')),
      );
    }

    return ClipRRect(
      borderRadius: AppRadius.allMd,
      child: SizedBox(
        height: 220,
        child: Stack(
          alignment: Alignment.center,
          children: <Widget>[
            mapbox.MapWidget(
              key: const ValueKey<String>('contribute-location-picker'),
              viewport: mapbox.CameraViewportState(
                center: mapbox.Point(
                  coordinates: mapbox.Position(
                    widget.initial.longitude,
                    widget.initial.latitude,
                  ),
                ),
                zoom: MapConfig.focusedZoom,
              ),
              onMapCreated: (mapbox.MapboxMap map) => _map = map,
              onMapIdleListener: (mapbox.MapIdleEventData data) =>
                  unawaited(_reportCentre(data)),
            ),
            /* A fixed marker over the centre: the map moves, the marker does not. */
            IgnorePointer(
              child: Icon(
                Icons.place,
                size: 40,
                color: Theme.of(context).colorScheme.primary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SignInRequired extends StatelessWidget {
  const _SignInRequired();

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Add a place')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(
                Icons.lock_outline,
                size: 40,
                color: theme.colorScheme.onSurfaceVariant,
              ),
              const SizedBox(height: AppSpacing.md),
              Text(
                'Sign in to add a place',
                style: theme.textTheme.titleMedium,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                'Exploring the map is open to everyone. Contributions are attributed '
                'to an account.',
                style: theme.textTheme.bodyMedium,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.lg),
              FilledButton(
                onPressed: () => context.goNamed(AuthRoutes.loginName),
                child: const Text('Sign in'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

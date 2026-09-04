import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_radius.dart';
import '../../../app/theme/app_spacing.dart';
import '../../../core/errors/app_failure.dart';
import '../application/places_providers.dart';
import '../domain/place.dart';
import 'place_category_visuals.dart';

/// Floating search over the map (§50).
///
/// Queries the real backend — there is no local list to filter. Typing is debounced
/// and each keystroke supersedes the request before it, so a fast typist produces
/// one round trip rather than one per character.
class PlaceSearchBar extends ConsumerStatefulWidget {
  const PlaceSearchBar({required this.onSelected, super.key});

  final void Function(PlaceListItem place) onSelected;

  @override
  ConsumerState<PlaceSearchBar> createState() => _PlaceSearchBarState();
}

class _PlaceSearchBarState extends ConsumerState<PlaceSearchBar> {
  static const Duration _debounce = Duration(milliseconds: 350);

  /// The backend requires at least two characters; asking earlier would return
  /// half the database.
  static const int _minimumQueryLength = 2;

  final TextEditingController _controller = TextEditingController();
  final FocusNode _focusNode = FocusNode();

  Timer? _timer;
  int _sequence = 0;
  List<PlaceListItem> _results = const <PlaceListItem>[];
  bool _isSearching = false;
  String? _error;

  @override
  void dispose() {
    _timer?.cancel();
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _onChanged(String value) {
    _timer?.cancel();
    final String term = value.trim();

    if (term.length < _minimumQueryLength) {
      setState(() {
        _results = const <PlaceListItem>[];
        _isSearching = false;
        _error = null;
      });
      return;
    }

    _timer = Timer(_debounce, () => unawaited(_search(term)));
  }

  Future<void> _search(String term) async {
    final int sequence = ++_sequence;
    setState(() {
      _isSearching = true;
      _error = null;
    });

    try {
      final List<PlaceListItem> results = await ref
          .read(placesApiProvider)
          .search(term, near: ref.read(mapControllerProvider).userPosition);

      /* A slower earlier query must not overwrite newer results. */
      if (!mounted || sequence != _sequence) return;
      setState(() {
        _results = results;
        _isSearching = false;
      });
    } on AppFailure catch (failure) {
      if (!mounted || sequence != _sequence) return;
      setState(() {
        _isSearching = false;
        _error = failure.kind == FailureKind.networkUnavailable
            ? 'No connection.'
            : 'Search is unavailable right now.';
      });
    }
  }

  void _clear() {
    _controller.clear();
    _focusNode.unfocus();
    setState(() {
      _results = const <PlaceListItem>[];
      _error = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Material(
          elevation: 3,
          borderRadius: AppRadius.allPill,
          color: theme.colorScheme.surface,
          child: TextField(
            controller: _controller,
            focusNode: _focusNode,
            onChanged: _onChanged,
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(
              hintText: 'Search places',
              // The icon alone is not a label for a screen reader.
              prefixIcon: const Icon(Icons.search, semanticLabel: 'Search'),
              suffixIcon: _isSearching
                  ? const Padding(
                      padding: EdgeInsets.all(AppSpacing.md),
                      child: SizedBox(
                        height: 16,
                        width: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    )
                  : (_controller.text.isEmpty
                        ? null
                        : IconButton(
                            icon: const Icon(Icons.clear),
                            tooltip: 'Clear search',
                            onPressed: _clear,
                          )),
              border: const OutlineInputBorder(
                borderRadius: AppRadius.allPill,
                borderSide: BorderSide.none,
              ),
              contentPadding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.md,
                vertical: AppSpacing.md,
              ),
            ),
          ),
        ),
        if (_error != null || _results.isNotEmpty || _showsEmptyState)
          Padding(
            padding: const EdgeInsets.only(top: AppSpacing.sm),
            child: Material(
              elevation: 3,
              borderRadius: AppRadius.allMd,
              color: theme.colorScheme.surface,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 280),
                child: _buildResults(theme),
              ),
            ),
          ),
      ],
    );
  }

  bool get _showsEmptyState =>
      !_isSearching &&
      _error == null &&
      _results.isEmpty &&
      _controller.text.trim().length >= _minimumQueryLength;

  Widget _buildResults(ThemeData theme) {
    final String? error = _error;
    if (error != null) {
      return Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Row(
          children: <Widget>[
            Icon(Icons.error_outline, size: 20, color: theme.colorScheme.error),
            const SizedBox(width: AppSpacing.sm),
            Expanded(child: Text(error, style: theme.textTheme.bodyMedium)),
          ],
        ),
      );
    }

    if (_showsEmptyState) {
      return const Padding(
        padding: EdgeInsets.all(AppSpacing.md),
        child: Text('No places match that search yet.'),
      );
    }

    return ListView.separated(
      shrinkWrap: true,
      itemCount: _results.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (BuildContext context, int index) {
        final PlaceListItem place = _results[index];
        final int? distance = place.distanceMetres;

        return ListTile(
          leading: Icon(
            PlaceCategoryVisuals.iconFor(place.categoryId),
            color: PlaceCategoryVisuals.colorFor(
              place.categoryId,
              theme.colorScheme,
            ),
          ),
          title: Text(place.name),
          subtitle: Text(
            distance == null
                ? PlaceCategoryVisuals.fallbackLabel(place.categoryId)
                : '${PlaceCategoryVisuals.fallbackLabel(place.categoryId)} · ${formatDistance(distance)}',
          ),
          onTap: () {
            _focusNode.unfocus();
            widget.onSelected(place);
          },
        );
      },
    );
  }
}

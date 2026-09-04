import 'package:equatable/equatable.dart';

/// The signed-in account as the UI needs it.
///
/// Mirrors `GET /api/v1/me`. Contains no credential material and no counters — the
/// constitution keeps reputation and social metrics out of V1 (§4).
class Account extends Equatable {
  const Account({
    required this.id,
    required this.email,
    required this.username,
    required this.displayName,
    this.bio,
    this.avatarUrl,
  });

  final String id;
  final String email;
  final String username;
  final String displayName;
  final String? bio;

  /// Always null in V1: there is no avatar upload yet, so the UI derives initials.
  final String? avatarUrl;

  /// Up to two initials from the display name, for the placeholder avatar (§43).
  String get initials {
    final List<String> parts = displayName
        .trim()
        .split(RegExp(r'\s+'))
        .where((String part) => part.isNotEmpty)
        .toList();

    if (parts.isEmpty) return '?';
    if (parts.length == 1) {
      return parts.first.characters1();
    }
    return '${parts.first.characters1()}${parts.last.characters1()}';
  }

  @override
  List<Object?> get props => <Object?>[
    id,
    email,
    username,
    displayName,
    bio,
    avatarUrl,
  ];
}

extension on String {
  /// First character, upper-cased. Safe for multi-byte input.
  String characters1() => isEmpty ? '' : substring(0, 1).toUpperCase();
}

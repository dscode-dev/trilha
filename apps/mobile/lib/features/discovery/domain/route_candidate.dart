import 'package:equatable/equatable.dart';

import '../../places/domain/place.dart';

/// A Place worth considering on a particular route (§6, §7).
///
/// Not a Place with a score attached. The same Place is an excellent candidate on one
/// journey and irrelevant on the next, so relevance belongs to the pairing rather than
/// to either side of it — which is why nothing here is cached, stored, or merged into
/// the Places the map already knows about.
class RouteCandidate extends Equatable {
  const RouteCandidate({
    required this.place,
    required this.distanceFromRouteMeters,
    required this.detourDistanceMeters,
    required this.detourDurationSeconds,
    required this.routeProgress,
    required this.relevanceScore,
    required this.relevanceReasons,
  });

  final CandidatePlace place;

  /// Shortest distance to the route line. Not the same as the detour (§17).
  final int distanceFromRouteMeters;

  /// Extra road distance and time from diverting through this Place.
  final int detourDistanceMeters;
  final int detourDurationSeconds;

  /// 0 at the origin, 1 at the destination.
  final double routeProgress;

  /// Ranking input only. Never shown to a user (§59).
  final double relevanceScore;

  final List<RelevanceReason> relevanceReasons;

  @override
  List<Object?> get props => <Object?>[
    place,
    distanceFromRouteMeters,
    detourDistanceMeters,
    detourDurationSeconds,
    routeProgress,
    relevanceScore,
    relevanceReasons,
  ];
}

/// The compact Place a candidate carries. Not a [PlaceDetail] (§40).
class CandidatePlace extends Equatable {
  const CandidatePlace({
    required this.id,
    required this.name,
    required this.categoryId,
    required this.position,
  });

  final String id;
  final String name;
  final String categoryId;
  final LatLng position;

  @override
  List<Object?> get props => <Object?>[id, name, categoryId, position];
}

/// Why the backend surfaced a candidate (§34, §35).
///
/// The server sends codes, never sentences: it has no business deciding how a
/// Brazilian traveller reads "+7 minutes", and a provider's own phrasing must never
/// reach a screen. [unknown] exists so a code added server-side degrades to silence
/// rather than to a crash.
enum RelevanceReason {
  onRoute,
  veryCloseToRoute,
  lowDetour,
  moderateDetour,
  goodRoutePosition,
  earlyInRoute,
  lateInRoute,
  unknown;

  static RelevanceReason fromCode(String code) => switch (code) {
    'ON_ROUTE' => RelevanceReason.onRoute,
    'VERY_CLOSE_TO_ROUTE' => RelevanceReason.veryCloseToRoute,
    'LOW_DETOUR' => RelevanceReason.lowDetour,
    'MODERATE_DETOUR' => RelevanceReason.moderateDetour,
    'GOOD_ROUTE_POSITION' => RelevanceReason.goodRoutePosition,
    'EARLY_IN_ROUTE' => RelevanceReason.earlyInRoute,
    'LATE_IN_ROUTE' => RelevanceReason.lateInRoute,
    _ => RelevanceReason.unknown,
  };
}

/// The result of one discovery request.
class DiscoveryResult extends Equatable {
  const DiscoveryResult({
    required this.candidates,
    required this.policyVersion,
  });

  final List<RouteCandidate> candidates;

  /// Which ranking policy produced this order. Carried for support and telemetry,
  /// never rendered (§36).
  final String policyVersion;

  @override
  List<Object?> get props => <Object?>[candidates, policyVersion];
}

/// How much longer the trip becomes, in words (§59).
///
/// Never the score. "+7 min" is a fact the traveller can act on; 0.91423 is an
/// implementation detail that would invite people to compare numbers that are not
/// comparable across policy versions.
String formatDetour(int seconds) {
  if (seconds < 60) return 'quase sem desvio';

  final int minutes = (seconds / 60).round();
  if (minutes < 60) return '+$minutes min';

  final int hours = minutes ~/ 60;
  final int rest = minutes % 60;
  return rest == 0
      ? '+${hours}h'
      : '+${hours}h${rest.toString().padLeft(2, '0')}';
}

/// The shortest honest explanation of why a candidate is here (§35).
///
/// One line, chosen from the codes the backend sent. Showing all of them would turn a
/// card into a list of adjectives; showing none would leave the ranking unexplained.
String? candidateReason(RouteCandidate candidate) {
  if (candidate.relevanceReasons.contains(RelevanceReason.onRoute)) {
    return 'Praticamente no seu caminho';
  }
  if (candidate.relevanceReasons.contains(RelevanceReason.lowDetour)) {
    return 'Pouco desvio da rota';
  }
  if (candidate.relevanceReasons.contains(RelevanceReason.veryCloseToRoute)) {
    return 'Bem perto da rota';
  }
  if (candidate.relevanceReasons.contains(RelevanceReason.moderateDetour)) {
    return 'Desvio moderado';
  }
  return null;
}

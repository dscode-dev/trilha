import 'package:equatable/equatable.dart';

/// Machine-readable failure kinds the UI can branch on.
///
/// Deliberately coarse: the client reacts to *categories* of failure (retry, sign in,
/// show a message), not to every server code.
enum AppErrorKind {
  /// No usable connection, DNS failure, or the host refused the socket.
  network,

  /// The request outlived its timeout.
  timeout,

  /// The caller cancelled the request; usually not worth surfacing.
  cancelled,

  /// 4xx that the user could plausibly fix.
  badRequest,

  /// 401/403.
  unauthorized,

  /// 404.
  notFound,

  /// 5xx, or a response the client could not parse.
  server,

  /// Anything not otherwise classified.
  unknown,
}

/// Base type for every error the app handles deliberately.
///
/// Carries a [kind] for control flow and a [message] that is safe to show a user.
/// Technical detail stays in [debugDetail], which is logged but never displayed
/// (§20: users never see stack traces).
sealed class AppException extends Equatable implements Exception {
  const AppException({
    required this.kind,
    required this.message,
    this.debugDetail,
    this.requestId,
    this.cause,
  });

  final AppErrorKind kind;
  final String message;
  final String? debugDetail;

  /// Correlation id echoed by the API, so a user report can be traced to a log.
  final String? requestId;
  final Object? cause;

  /// Whether retrying the same request could plausibly succeed.
  bool get isRetryable =>
      kind == AppErrorKind.network ||
      kind == AppErrorKind.timeout ||
      kind == AppErrorKind.server;

  @override
  List<Object?> get props => [kind, message, debugDetail, requestId];

  @override
  String toString() => '$runtimeType(${kind.name}): $message';
}

/// A failure originating from an HTTP call.
final class ApiException extends AppException {
  const ApiException({
    required super.kind,
    required super.message,
    this.statusCode,
    this.code,
    super.debugDetail,
    super.requestId,
    super.cause,
  });

  /// HTTP status, when the request reached the server.
  final int? statusCode;

  /// The API's machine-readable `error.code`, when present.
  final String? code;

  @override
  List<Object?> get props => [...super.props, statusCode, code];
}

/// A failure raised while the app was starting up (§20).
final class BootstrapException extends AppException {
  const BootstrapException({
    required super.message,
    super.debugDetail,
    super.cause,
  }) : super(kind: AppErrorKind.unknown);
}

import 'app/app.dart';
import 'app/bootstrap/bootstrap.dart';

/// Entry point. All start-up logic — including error handling — lives in
/// [bootstrap], so tests can start the app the same way production does.
Future<void> main() => bootstrap(builder: TrilhaApp.new);

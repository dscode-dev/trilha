import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trilha_mobile/features/auth/data/secure_token_store.dart';

/// Secure storage configuration and behaviour (§37).
///
/// The platform channel is faked, because a test binding has no Keychain and no
/// Keystore. What is asserted is what this layer actually controls: which key is
/// used, which platform options are requested, and that a corrupt entry degrades to
/// "signed out" instead of crashing the launch.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const MethodChannel channel = MethodChannel(
    'plugins.it_nomads.com/flutter_secure_storage',
  );

  late List<MethodCall> calls;
  late Map<String, String> backing;
  bool throwOnRead = false;

  setUp(() {
    calls = <MethodCall>[];
    backing = <String, String>{};
    throwOnRead = false;

    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (MethodCall call) async {
          calls.add(call);
          final Map<Object?, Object?> args =
              (call.arguments as Map<Object?, Object?>?) ??
              <Object?, Object?>{};
          final String key = (args['key'] as String?) ?? '';

          switch (call.method) {
            case 'read':
              if (throwOnRead) {
                throw PlatformException(
                  code: 'Decrypt',
                  message: 'corrupt entry',
                );
              }
              return backing[key];
            case 'write':
              backing[key] = args['value']! as String;
              return null;
            case 'delete':
              backing.remove(key);
              return null;
            default:
              return null;
          }
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  SecureTokenStore store() =>
      SecureTokenStore(SecureTokenStore.defaultStorage());

  test('round-trips a refresh token', () async {
    await store().writeRefreshToken('refresh-abc');
    expect(await store().readRefreshToken(), 'refresh-abc');
  });

  test('reports no token when nothing is stored', () async {
    expect(await store().readRefreshToken(), isNull);
  });

  test('treats an empty stored value as absent', () async {
    await store().writeRefreshToken('');
    expect(await store().readRefreshToken(), isNull);
  });

  test('clear removes the token', () async {
    await store().writeRefreshToken('refresh-abc');
    await store().clear();

    expect(await store().readRefreshToken(), isNull);
  });

  test('uses one namespaced key', () async {
    await store().writeRefreshToken('refresh-abc');

    final MethodCall write = calls.firstWhere(
      (MethodCall c) => c.method == 'write',
    );
    final Map<Object?, Object?> args = write.arguments as Map<Object?, Object?>;
    expect(args['key'], SecureTokenStore.refreshTokenKey);
    expect(SecureTokenStore.refreshTokenKey, startsWith('trilha.'));
  });

  test('a corrupt entry signs the user out instead of crashing', () async {
    await store().writeRefreshToken('refresh-abc');
    throwOnRead = true;

    // After a device restore the entry may be undecryptable. That must present as
    // "no session", never as an exception on launch.
    expect(await store().readRefreshToken(), isNull);
    expect(calls.any((MethodCall c) => c.method == 'delete'), isTrue);
  });

  group('platform options', () {
    test('iOS keeps the token on-device and out of iCloud', () {
      const FlutterSecureStorage storage = FlutterSecureStorage(
        iOptions: IOSOptions(
          accessibility: KeychainAccessibility.first_unlock_this_device,
          synchronizable: false,
        ),
      );

      final Map<String, String> options = storage.iOptions.params;
      expect(options['accessibility'], 'first_unlock_this_device');
      expect(options['synchronizable'], 'false');
    });

    test('the production store requests those iOS options', () {
      final FlutterSecureStorage storage = SecureTokenStore.defaultStorage();

      expect(
        storage.iOptions.params['accessibility'],
        'first_unlock_this_device',
      );
      expect(
        storage.iOptions.params['synchronizable'],
        'false',
        reason: 'a refresh token must not follow the user to another device',
      );
    });

    test('the production store uses Keystore-backed Android defaults', () {
      final FlutterSecureStorage storage = SecureTokenStore.defaultStorage();
      final Map<String, String> options = storage.aOptions.params;

      // v11 defaults to AES-GCM data encryption with RSA-OAEP key wrapping held in
      // the Android Keystore; SharedPreferences alone would be readable when rooted.
      expect(options['storageCipherAlgorithm'], contains('AES_GCM'));
      expect(options['keyCipherAlgorithm'], contains('RSA'));
    });
  });
}

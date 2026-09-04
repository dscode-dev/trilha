import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Persists the refresh token in platform-backed secure storage (§37).
///
/// iOS uses the Keychain and Android an AES key held in the Keystore, so the token
/// is protected by hardware-backed key material rather than by file permissions.
/// `SharedPreferences`, a plain file and an unencrypted database are all excluded:
/// each is readable on a rooted or jailbroken device.
///
/// The access token is never written here. It expires in minutes, so persisting it
/// would add attack surface in exchange for nothing.
abstract interface class TokenStore {
  Future<String?> readRefreshToken();
  Future<void> writeRefreshToken(String token);
  Future<void> clear();
}

class SecureTokenStore implements TokenStore {
  const SecureTokenStore(this._storage);

  /// Namespaced so an unrelated key can never be mistaken for ours.
  static const String refreshTokenKey = 'trilha.auth.refresh_token';

  static FlutterSecureStorage defaultStorage() => const FlutterSecureStorage(
    // v11's defaults are already the hardened path: AES-GCM data encryption with
    // RSA-OAEP key wrapping held in the Android Keystore. `resetOnError` discards an
    // entry that can no longer be decrypted — after a device restore, say — so a
    // damaged token presents as "signed out" rather than bricking the launch.
    aOptions: AndroidOptions(),
    iOptions: IOSOptions(
      // Readable only after the first unlock, and never synced to iCloud or carried
      // to another device: a refresh token is bound to the install that earned it.
      accessibility: KeychainAccessibility.first_unlock_this_device,
      synchronizable: false,
    ),
  );

  final FlutterSecureStorage _storage;

  @override
  Future<String?> readRefreshToken() async {
    try {
      final String? token = await _storage.read(key: refreshTokenKey);
      return (token == null || token.isEmpty) ? null : token;
    } on PlatformException {
      // A corrupt or undecryptable entry — after a restore onto new hardware, for
      // instance — must present as "no session", not as a crash on launch.
      await clear();
      return null;
    }
  }

  @override
  Future<void> writeRefreshToken(String token) =>
      _storage.write(key: refreshTokenKey, value: token);

  @override
  Future<void> clear() => _storage.delete(key: refreshTokenKey);
}

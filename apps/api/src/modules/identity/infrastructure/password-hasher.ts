import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Argon2id password hashing (§9, §53).
 *
 * Parameters were chosen by measurement, not by guess. Benchmarked on the reference
 * development machine (2026-09-04):
 *
 *   m=19 MiB,  t=2, p=1  →  ~25 ms   (OWASP floor; cheaper than we want)
 *   m=46 MiB,  t=3, p=1  →  ~89 ms   ← selected
 *   m=64 MiB,  t=3, p=4  →  ~50 ms
 *
 * The selected setting lands on the ~100 ms interactive budget and is well above the
 * OWASP minimum on the memory axis, which is the axis that actually degrades GPU and
 * ASIC attacks. `p=1` keeps one login to one core, so throughput is governed by the
 * pool rather than by threads fighting each other.
 *
 * Capacity note: each in-flight hash reserves ~46 MiB. Concurrency is bounded by the
 * login rate limiter; raising the limiter's ceiling means revisiting this number.
 */
export const ARGON2_PARAMETERS = {
  algorithm: Algorithm.Argon2id,
  /** KiB. 47104 KiB = 46 MiB. */
  memoryCost: 47_104,
  timeCost: 3,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordHasher {
  /**
   * Returns a PHC-format string that embeds algorithm, parameters, salt and digest,
   * so a future parameter change can be detected per-record rather than guessed.
   */
  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, ARGON2_PARAMETERS);
  }

  /**
   * Constant-time comparison performed inside Argon2. A malformed or unknown-format
   * stored hash returns false rather than throwing, so one corrupt row cannot turn a
   * login attempt into a 500.
   */
  async verify(storedHash: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(storedHash, plaintext, ARGON2_PARAMETERS);
    } catch {
      return false;
    }
  }
}

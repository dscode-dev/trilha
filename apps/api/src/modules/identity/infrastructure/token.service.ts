import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { AppConfig } from '../../../infrastructure/config/app-config.js';
import { InvalidTokenError } from '../domain/identity-errors.js';

/**
 * Issues and validates the two token types (§13, §14).
 *
 * **Access token** — a short-lived JWT carrying the minimum needed to authorise a
 * request: who (`sub`) and which session (`sid`). No profile data: a token is a
 * bearer credential that travels through logs and proxies, and it would go stale the
 * moment a display name changed.
 *
 * **Refresh token** — 256 bits from the CSPRNG, opaque to the client. Nothing is
 * derived from it and it is never persisted in the clear; only its SHA-256 is stored.
 */

/** Claims Trilha issues. Anything absent is intentionally absent. */
export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Session id, so a token can be tied to the session that produced it. */
  sid: string;
}

export interface IssuedRefreshToken {
  /** Returned to the client exactly once; never stored in this form. */
  token: string;
  /** What goes in the database. */
  tokenHash: string;
}

/** 32 bytes = 256 bits of entropy; guessing is not a threat model. */
const REFRESH_TOKEN_BYTES = 32;

@Injectable()
export class TokenService {
  private readonly secret: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly ipHashKey: string;

  constructor(private readonly config: AppConfig) {
    this.secret = new TextEncoder().encode(config.auth.accessTokenSecret);
    this.issuer = config.auth.issuer;
    this.audience = config.auth.audience;
    this.ipHashKey = config.auth.ipHashKey;
  }

  /** Seconds an access token remains valid. Exposed so responses can advertise it. */
  get accessTokenTtlSeconds(): number {
    return this.config.auth.accessTokenTtlSeconds;
  }

  get refreshTokenTtlSeconds(): number {
    return this.config.auth.refreshTokenTtlSeconds;
  }

  async issueAccessToken(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ sid: claims.sid })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt()
      .setExpirationTime(`${String(this.accessTokenTtlSeconds)}s`)
      .sign(this.secret);
  }

  /**
   * Verifies signature, expiry, issuer and audience.
   *
   * Issuer and audience are checked explicitly: without them a token minted by another
   * service sharing the secret would be accepted here (§49).
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.secret, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['HS256'],
      }));
    } catch {
      /* jose distinguishes expired from malformed from wrong-audience; the client
         gets one answer for all of them — re-authenticate. */
      throw new InvalidTokenError();
    }

    const { sub, sid } = payload;
    if (typeof sub !== 'string' || sub.length === 0) throw new InvalidTokenError();
    if (typeof sid !== 'string' || sid.length === 0) throw new InvalidTokenError();

    return { sub, sid };
  }

  /** Mints a refresh token, returning the client copy and the storable digest. */
  issueRefreshToken(): IssuedRefreshToken {
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    return { token, tokenHash: this.hashRefreshToken(token) };
  }

  /**
   * SHA-256, not Argon2 (§54).
   *
   * Password hashing is slow on purpose because passwords are low-entropy and
   * guessable. A refresh token is 256 uniform random bits, so there is no dictionary
   * to run and no work factor worth paying: the only property needed is that a
   * database leak does not yield usable tokens, which a one-way digest provides.
   * It also keeps refresh — the hot path — from costing 90 ms per call.
   */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /**
   * Keyed digest of a client address for audit records (§18, §48).
   *
   * Keyed so the mapping cannot be reversed with a rainbow table over the small IPv4
   * space — a plain SHA-256 of an IP address is trivially invertible.
   */
  hashIpAddress(ip: string): string {
    return createHash('sha256').update(`${this.ipHashKey}:${ip}`, 'utf8').digest('hex');
  }

  /** Constant-time equality for opaque token digests. */
  static digestsMatch(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }
}

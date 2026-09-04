import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { httpServer } from './http.js';
import { registerAccount, type AuthTokens } from './identity.js';

/**
 * Real coordinates, so distance assertions mean something (§60).
 *
 * Verified against PostGIS: Marco Zero → Igreja da Sé is ~6.2 km, which matches the
 * real-world distance between central Recife and Olinda's cathedral hill.
 */
export const LANDMARKS = {
  marcoZero: { latitude: -8.0631, longitude: -34.8711, name: 'Marco Zero' },
  igrejaDaSe: { latitude: -8.0089, longitude: -34.8553, name: 'Igreja da Sé' },
  boaViagem: { latitude: -8.1194, longitude: -34.8975, name: 'Praia de Boa Viagem' },
  jaboatao: { latitude: -8.1128, longitude: -35.0148, name: 'Jaboatão dos Guararapes' },
  joaoPessoa: { latitude: -7.115, longitude: -34.8631, name: 'João Pessoa' },
  saoPaulo: { latitude: -23.5505, longitude: -46.6333, name: 'São Paulo' },
} as const;

export interface CreatedPlace {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  categoryId: string;
}

/** A contributor session, created through the real registration endpoint. */
export async function contributor(app: INestApplication): Promise<AuthTokens> {
  return (await registerAccount(app)).tokens;
}

export async function createPlace(
  app: INestApplication,
  tokens: AuthTokens,
  place: {
    name: string;
    latitude: number;
    longitude: number;
    categoryId?: string;
    description?: string | null;
  },
): Promise<CreatedPlace> {
  const response = await request(httpServer(app))
    .post('/api/v1/places')
    .set('Authorization', `Bearer ${tokens.accessToken}`)
    .send({
      name: place.name,
      categoryId: place.categoryId ?? 'LANDMARK',
      latitude: place.latitude,
      longitude: place.longitude,
      description: place.description ?? null,
    })
    .expect(201);

  return (response.body as { place: CreatedPlace }).place;
}

/** A name unique to one test run, so suites can share a database. */
export function uniquePlaceName(prefix: string): string {
  return `${prefix} ${Math.random().toString(36).slice(2, 10)}`;
}

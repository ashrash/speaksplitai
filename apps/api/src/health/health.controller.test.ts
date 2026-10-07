import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';

async function build(query: () => Promise<unknown>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [{ provide: DataSource, useValue: { query } }],
  }).compile();
  return moduleRef.get(HealthController);
}

describe('HealthController', () => {
  it('reports liveness', async () => {
    const controller = await build(vi.fn());
    expect(controller.live().status).toBe('ok');
  });

  it('reports readiness when the database answers', async () => {
    const controller = await build(vi.fn().mockResolvedValue([{ '?column?': 1 }]));
    await expect(controller.ready()).resolves.toMatchObject({ status: 'ok' });
  });

  it('fails readiness when the database is down', async () => {
    const controller = await build(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

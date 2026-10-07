import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import type { HealthResponse } from '@speaksplit/api-types';
import { DataSource } from 'typeorm';

@Controller('health')
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  /** Liveness: the process is up. */
  @Get()
  live(): HealthResponse {
    return { status: 'ok', version: process.env.npm_package_version ?? 'dev' };
  }

  /** Readiness: the database answers. */
  @Get('ready')
  async ready(): Promise<HealthResponse> {
    try {
      await this.dataSource.query('select 1');
    } catch {
      throw new ServiceUnavailableException('database unavailable');
    }
    return this.live();
  }
}

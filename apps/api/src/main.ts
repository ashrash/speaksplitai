import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';
import { configureApp } from './setup.js';

async function bootstrap() {
  const app = configureApp(await NestFactory.create(AppModule, { bufferLogs: true }));
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  await app.listen(config.get('API_PORT', { infer: true }));
}

void bootstrap();

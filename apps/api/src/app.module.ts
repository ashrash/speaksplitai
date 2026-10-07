import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { AuthGuard } from './auth/auth.guard.js';
import { JWKS, remoteJwks } from './auth/jwks.js';
import { ErrorsFilter } from './common/errors.filter.js';
import { requestId } from './common/request-id.js';
import { type Env, validateEnv } from './config/env.js';
import { typeormOptions } from './database/typeorm-options.js';
import { GroupsController } from './groups/groups.controller.js';
import { GroupsService } from './groups/groups.service.js';
import { HealthController } from './health/health.controller.js';
import { MeController } from './users/me.controller.js';
import { ProfileService } from './users/profile.service.js';
import { UsersService } from './users/users.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          genReqId: requestId,
          // never log tokens or cookies
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["idempotency-key"]',
          ],
          customProps: (req) => ({ userId: (req as { user?: { id: string } }).user?.id }),
          ...(config.get('NODE_ENV', { infer: true }) === 'development'
            ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
            : {}),
        },
      }),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        typeormOptions(config.get('DATABASE_URL', { infer: true })),
    }),
  ],
  controllers: [HealthController, MeController, GroupsController],
  providers: [
    UsersService,
    ProfileService,
    GroupsService,
    {
      provide: JWKS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        remoteJwks(config.get('AUTH0_ISSUER_URL', { infer: true })),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorsFilter },
  ],
})
export class AppModule {}

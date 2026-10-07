import type { INestApplication } from '@nestjs/common';
import type { Express } from 'express';
import { Logger } from 'nestjs-pino';

/** Settings shared by the real server and the end-to-end tests. */
export function configureApp(app: INestApplication): INestApplication {
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  (app.getHttpAdapter().getInstance() as Express).disable('x-powered-by');
  return app;
}

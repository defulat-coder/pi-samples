import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = buildApp(config);

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`Pi Workbench API listening on http://${config.HOST}:${config.PORT}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

/**
 * Boot: read config, open the database, start listening.
 *   node --env-file=.env src/index.js
 */
import http from 'node:http';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createMailer } from './mail.js';
import { createYoupiClient } from './youpi.js';

const config = loadConfig();
const app = createApp({
  config,
  db: openDatabase(config.dataDir),
  youpi: createYoupiClient(config.youpi),
  mailer: await createMailer(config)
});

app.sweep();
setInterval(() => {
  try { app.sweep(); } catch (err) { console.error(`[sweep] ${err.message}`); }
}, 3600 * 1000).unref();

http.createServer(app.handle).listen(config.port, () => {
  console.log(`Ticky API on :${config.port}  ·  API_BASE = ${config.publicUrl}/api  ·  YouPI webhook = ${config.publicUrl}/youpi/webhook`);
});

import express from 'express';
import { createApp as createDaybookApp } from './app-v2.js';
import { config } from './config.js';
import { createReminderRouter, startDaybookReminderScheduler } from './notifications/reminders.js';

// Build the Daybook app first so its database/media directories exist, but
// mount reminder routes before it because the Daybook app owns the final 404.
const daybookApp = createDaybookApp();
const app = express();
app.use(createReminderRouter());
app.use(daybookApp);

const stopReminders = startDaybookReminderScheduler();
const server = app.listen(config.port, config.host, () => {
  console.log(`yuvomi-daybook listening on http://${config.host}:${config.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopReminders();
    server.close(() => process.exit(0));
  });
}

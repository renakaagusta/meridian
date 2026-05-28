module.exports = {
  apps: [
    {
      name: "meridian",
      script: "index.js",
      cwd: __dirname,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      // Daily benchmark snapshot — runs once, exits, re-runs daily at 09:00 via cron.
      name: "meridian-snapshot",
      script: "scripts/daily-snapshot.js",
      cwd: __dirname,
      interpreter: "node",
      autorestart: false,        // one-shot; do not keep alive
      cron_restart: "0 9 * * *", // 09:00 every day (server local time)
      env: {
        NODE_ENV: "production",
      },
    },
    {
      // Weekly config evaluation — Monday 10:00. Refreshes top pools + writes a report.
      name: "meridian-eval",
      script: "scripts/periodic-eval.js",
      cwd: __dirname,
      interpreter: "node",
      autorestart: false,
      cron_restart: "0 10 * * 1", // Monday 10:00
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};

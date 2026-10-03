// PM2 process config. The project is ESM ("type":"module"), so this file is
// .cjs. tsx runs the TypeScript entry directly (no build step).
module.exports = {
  apps: [
    {
      name: "dextg-bot",
      script: "./node_modules/.bin/tsx",
      args: "src/index.ts",
      interpreter: "none", // tsx is itself the executable
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      time: true
    }
  ]
};

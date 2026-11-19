module.exports = {
  apps: [{
    name: "discord-bot-app",
    script: "./server.ts",
    interpreter: "node",
    interpreter_args: "--import tsx",
    env: {
      NODE_ENV: "production",
      PORT: 3000
    }
  }]
}

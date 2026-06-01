module.exports = {
  apps: [{
    name: 'trading-journal',
    script: 'server/index.js',
    cwd: '/home/mmoniz/trading-journal',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    log_file: '/home/mmoniz/trading-journal/logs/combined.log',
    error_file: '/home/mmoniz/trading-journal/logs/error.log',
    out_file: '/home/mmoniz/trading-journal/logs/out.log',
    time: true
  }]
};

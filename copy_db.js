import fs from 'fs';
if (fs.existsSync('economy.db')) {
  if (!fs.existsSync('.data')) fs.mkdirSync('.data');
  fs.copyFileSync('economy.db', '.data/economy.db');
}

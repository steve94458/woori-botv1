import * as fs from 'fs';

let code = fs.readFileSync('server.ts', 'utf8');

// 1. Move db.function after db declaration
const customFunctions = `
  db.function('addBigInt', (a, b) => (BigInt(a || 0) + BigInt(b || 0)).toString());
  db.function('subBigInt', (a, b) => (BigInt(a || 0) - BigInt(b || 0)).toString());
  db.function('mulBigInt', (a, b) => (BigInt(a || 0) * BigInt(b || 0)).toString());
  db.function('divBigInt', (a, b) => (BigInt(a || 0) / BigInt(b || 1)).toString());
`;

code = code.replace(
  '// --- 데이터베이스 초기화 ---\n' + customFunctions,
  '// --- 데이터베이스 초기화 ---\n'
);

code = code.replace(
  'const db = new Database(".data/economy.db");',
  'const db = new Database(".data/economy.db");\n' + customFunctions
);

// 2. Fix specific line errors
code = code.replace(/s\.formatMoney\(price\)/g, 'formatMoney(s.price)');
code = code.replace(/h\.formatMoney\(price\)/g, 'formatMoney(h.price)');
code = code.replace(/d\.formatMoney\(price\)/g, 'formatMoney(d.price)');
code = code.replace(/item\.formatMoney\(price\)/g, 'formatMoney(item.price)');
code = code.replace(/l\.current_formatMoney\(amount\)/g, 'formatMoney(l.current_amount)');
code = code.replace(/duel\.formatMoney\(amount\)/g, 'formatMoney(duel.amount)');
code = code.replace(/game\.formatMoney\(amount\)/g, 'formatMoney(game.amount)');

code = code.replace(/const total = Object\.values\(scores\)\.reduce\(\(sum: any, val: any\) => sum \+ \(val \|\| 0\), 0\) \+ bonus;/g, 'const total = Object.values(scores).reduce((sum: any, val: any) => Number(sum) + Number(val || 0), 0) + Number(bonus);');

code = code.replace(/gameState\.formatMoney\(amount\)/g, 'formatMoney(gameState.amount)');
code = code.replace(/let winAmount = 0;/g, 'let winAmount = 0n;');

code = code.replace(/const winAmount = Math\.floor\(amount \* multiplier\);/g, 'const winAmount = (amount * BigInt(Math.floor(multiplier * 100))) / 100n;');
code = code.replace(/const winAmount = amount \* multiplier;/g, 'const winAmount = amount * BigInt(multiplier);');

code = code.replace(/const winAmount = Math\.floor\(\(amount \* BigInt\(Math\.floor\(target \* 100\)\)\) \/ 100n\);/g, 'const winAmount = (amount * BigInt(Math.floor(target * 100))) / 100n;');

code = code.replace(/const actualSeizure = Math\.min\(account\.balance, amount\);/g, 'const actualSeizure = BigInt(account.balance) < amount ? BigInt(account.balance) : amount;');
code = code.replace(/actualSeizure\.toLocaleString\(\)/g, 'formatMoney(actualSeizure)');

fs.writeFileSync('server.ts', code);
console.log('Fixed specific TS errors!');

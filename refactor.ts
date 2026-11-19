import * as fs from 'fs';

let code = fs.readFileSync('server.ts', 'utf8');

// 1. Add custom functions to db initialization
const customFunctions = `
  db.function('addBigInt', (a, b) => (BigInt(a || 0) + BigInt(b || 0)).toString());
  db.function('subBigInt', (a, b) => (BigInt(a || 0) - BigInt(b || 0)).toString());
  db.function('mulBigInt', (a, b) => (BigInt(a || 0) * BigInt(b || 0)).toString());
  db.function('divBigInt', (a, b) => (BigInt(a || 0) / BigInt(b || 1)).toString());
`;

code = code.replace(
  '// --- 데이터베이스 초기화 ---',
  '// --- 데이터베이스 초기화 ---\n' + customFunctions
);

// 2. Add parseMoney helper
const parseMoneyHelper = `
function parseMoney(str: string): bigint | null {
  try {
    const val = BigInt(str.replace(/,/g, ''));
    return val;
  } catch {
    return null;
  }
}
function formatMoney(val: any): string {
  if (val === null || val === undefined) return "0";
  return BigInt(val).toLocaleString();
}
`;

code = code.replace(
  '// --- 은행 유틸리티 ---',
  parseMoneyHelper + '\n// --- 은행 유틸리티 ---'
);

// 3. Replace balance = balance +/- ? with addBigInt/subBigInt
code = code.replace(/balance = balance \+ \?/g, 'balance = addBigInt(balance, ?)');
code = code.replace(/balance = balance - \?/g, 'balance = subBigInt(balance, ?)');
code = code.replace(/totalCost = totalCost \+ \?/g, 'totalCost = addBigInt(totalCost, ?)');
code = code.replace(/totalCost = totalCost - \?/g, 'totalCost = subBigInt(totalCost, ?)');
code = code.replace(/principal = principal - \?/g, 'principal = subBigInt(principal, ?)');
code = code.replace(/current_amount = current_amount - \?/g, 'current_amount = subBigInt(current_amount, ?)');
code = code.replace(/price = price \+ \?/g, 'price = addBigInt(price, ?)');
code = code.replace(/price = price - \?/g, 'price = subBigInt(price, ?)');

// 4. Replace parseInt(args[x]) with parseMoney(args[x]) for money amounts
// We need to be careful. Let's do it manually for the specific commands.
// I will output the modified code to a new file and then we can review it.

fs.writeFileSync('server_refactored.ts', code);
console.log('Refactored code written to server_refactored.ts');

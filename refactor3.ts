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

// 4. Replace parseInt with parseMoney for amount and price
code = code.replace(/const amount = parseInt\(args\[(\d+)\]\);/g, 'const amount = parseMoney(args[$1]);');
code = code.replace(/const price = parseInt\(args\[(\d+)\]\);/g, 'const price = parseMoney(args[$1]);');

// 5. Replace isNaN(amount) and isNaN(price)
code = code.replace(/isNaN\(amount\)/g, 'amount === null');
code = code.replace(/isNaN\(price\)/g, 'price === null');

// 6. Replace amount <= 0 and price <= 0
code = code.replace(/amount <= 0/g, 'amount <= 0n');
code = code.replace(/price <= 0/g, 'price <= 0n');

// 7. Replace amount * X with amount * Xn
code = code.replace(/amount \* 2/g, 'amount * 2n');
code = code.replace(/amount \* 3/g, 'amount * 3n');
code = code.replace(/amount \* 4/g, 'amount * 4n');
code = code.replace(/amount \* 5/g, 'amount * 5n');
code = code.replace(/amount \* 6/g, 'amount * 6n');
code = code.replace(/amount \* 9/g, 'amount * 9n');
code = code.replace(/amount \* 10/g, 'amount * 10n');
code = code.replace(/amount \* 14/g, 'amount * 14n');
code = code.replace(/amount \* 25/g, 'amount * 25n');
code = code.replace(/amount \* 50/g, 'amount * 50n');
code = code.replace(/amount \* 100/g, 'amount * 100n');
code = code.replace(/amount \* 250/g, 'amount * 250n');

// 8. Replace specific float multiplications
code = code.replace(/amount \* 1\.5/g, '(amount * 15n) / 10n');
code = code.replace(/amount \* target/g, '(amount * BigInt(Math.floor(target * 100))) / 100n');
code = code.replace(/amount \* 0\.5/g, '(amount * 5n) / 10n');
code = code.replace(/device\.price \* 0\.5/g, '(BigInt(device.price) * 5n) / 10n');

// 9. Replace Math.floor division
code = code.replace(/Math\.floor\(account\.balance \/ stock\.price\)/g, 'Number(BigInt(account.balance) / BigInt(stock.price))');
code = code.replace(/Math\.floor\(account\.balance \/ device\.price\)/g, 'Number(BigInt(account.balance) / BigInt(device.price))');

// 10. Replace balance/cost comparisons
code = code.replace(/account\.balance < amount/g, 'BigInt(account.balance) < amount');
code = code.replace(/account\.balance < cost/g, 'BigInt(account.balance) < BigInt(cost)');
code = code.replace(/account\.balance < totalCost/g, 'BigInt(account.balance) < BigInt(totalCost)');
code = code.replace(/account\.balance < price/g, 'BigInt(account.balance) < BigInt(price)');
code = code.replace(/account\.balance >= amount/g, 'BigInt(account.balance) >= amount');

// 11. Replace toLocaleString
code = code.replace(/account\.balance\.toLocaleString\(\)/g, 'formatMoney(account.balance)');
code = code.replace(/totalCost\.toLocaleString\(\)/g, 'formatMoney(totalCost)');
code = code.replace(/price\.toLocaleString\(\)/g, 'formatMoney(price)');
code = code.replace(/amount\.toLocaleString\(\)/g, 'formatMoney(amount)');
code = code.replace(/stock\.price\.toLocaleString\(\)/g, 'formatMoney(stock.price)');
code = code.replace(/device\.price\.toLocaleString\(\)/g, 'formatMoney(device.price)');

// 12. Replace parseInt(amountStr)
code = code.replace(/parseInt\(amountStr\)/g, 'parseMoney(amountStr)');

// 13. Replace amountStr === "전부" logic
code = code.replace(/amountStr === "전부" \? account\.balance : parseMoney\(amountStr\)/g, 'amountStr === "전부" ? BigInt(account.balance) : parseMoney(amountStr)');
code = code.replace(/amountStr === "전부" \? loan\.current_amount : parseMoney\(amountStr\)/g, 'amountStr === "전부" ? BigInt(loan.current_amount) : parseMoney(amountStr)');

// 14. Replace totalCost calculations
code = code.replace(/const totalCost = stock\.price \* quantity;/g, 'const totalCost = BigInt(stock.price) * BigInt(quantity);');
code = code.replace(/const totalCost = device\.price \* quantity;/g, 'const totalCost = BigInt(device.price) * BigInt(quantity);');
code = code.replace(/const totalCost = costPerExpansion \* quantity;/g, 'const totalCost = BigInt(costPerExpansion) * BigInt(quantity);');
code = code.replace(/const totalCost = quantity \* 100000000;/g, 'const totalCost = BigInt(quantity) * 100000000n;');

// 15. Replace cost constants
code = code.replace(/const cost = 100000000;/g, 'const cost = 100000000n;');
code = code.replace(/const costPerExpansion = 100000000;/g, 'const costPerExpansion = 100000000n;');

// 16. Fix specific TS errors from previous run
// Fix: Type 'bigint' is not assignable to type 'number'
// In server.ts, there might be places where amount is passed to a function expecting number.
// Actually, I can just write the refactored code to server.ts directly and then manually fix the remaining TS errors.

fs.writeFileSync('server.ts', code);
console.log('Refactored code written to server.ts');

import * as fs from 'fs';

let code = fs.readFileSync('server_refactored.ts', 'utf8');

// Replace parseInt with parseMoney for amount and price
code = code.replace(/const amount = parseInt\(args\[(\d+)\]\);/g, 'const amount = parseMoney(args[$1]);');
code = code.replace(/const price = parseInt\(args\[(\d+)\]\);/g, 'const price = parseMoney(args[$1]);');

// Replace isNaN(amount) with amount === null
code = code.replace(/isNaN\(amount\)/g, 'amount === null');
code = code.replace(/isNaN\(price\)/g, 'price === null');

// Replace amount <= 0 with amount <= 0n
code = code.replace(/amount <= 0/g, 'amount <= 0n');
code = code.replace(/price <= 0/g, 'price <= 0n');

// Replace amount * 2 with amount * 2n
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

// Replace amount * 1.5 with (amount * 15n) / 10n
code = code.replace(/amount \* 1\.5/g, '(amount * 15n) / 10n');

// Replace amount * target with (amount * BigInt(Math.floor(target * 100))) / 100n
code = code.replace(/amount \* target/g, '(amount * BigInt(Math.floor(target * 100))) / 100n');

// Replace Math.floor(account.balance / stock.price) with Number(BigInt(account.balance) / BigInt(stock.price))
code = code.replace(/Math\.floor\(account\.balance \/ stock\.price\)/g, 'Number(BigInt(account.balance) / BigInt(stock.price))');
code = code.replace(/Math\.floor\(account\.balance \/ device\.price\)/g, 'Number(BigInt(account.balance) / BigInt(device.price))');

// Replace account.balance < amount with BigInt(account.balance) < amount
code = code.replace(/account\.balance < amount/g, 'BigInt(account.balance) < amount');
code = code.replace(/account\.balance < cost/g, 'BigInt(account.balance) < BigInt(cost)');
code = code.replace(/account\.balance < totalCost/g, 'BigInt(account.balance) < BigInt(totalCost)');
code = code.replace(/account\.balance < price/g, 'BigInt(account.balance) < BigInt(price)');

// Replace account.balance >= amount with BigInt(account.balance) >= amount
code = code.replace(/account\.balance >= amount/g, 'BigInt(account.balance) >= amount');

// Replace account.balance with formatMoney(account.balance) in replies
// Actually, it's easier to just use formatMoney(account.balance) everywhere it's displayed.
// Let's replace .toLocaleString() with formatMoney()
// Wait, amount.toLocaleString() works for BigInt too! So we don't need to change .toLocaleString() for amount.
// But account.balance is a string now, so account.balance.toLocaleString() will fail.
code = code.replace(/account\.balance\.toLocaleString\(\)/g, 'formatMoney(account.balance)');
code = code.replace(/totalCost\.toLocaleString\(\)/g, 'formatMoney(totalCost)');
code = code.replace(/price\.toLocaleString\(\)/g, 'formatMoney(price)');
code = code.replace(/amount\.toLocaleString\(\)/g, 'formatMoney(amount)');
code = code.replace(/stock\.price\.toLocaleString\(\)/g, 'formatMoney(stock.price)');
code = code.replace(/device\.price\.toLocaleString\(\)/g, 'formatMoney(device.price)');

// Replace parseInt(amountStr) with parseMoney(amountStr)
code = code.replace(/parseInt\(amountStr\)/g, 'parseMoney(amountStr)');

// Replace amountStr === "전부" ? account.balance : parseMoney(amountStr)
// Wait, if amountStr === "전부", amount should be BigInt(account.balance).
code = code.replace(/amountStr === "전부" \? account\.balance : parseMoney\(amountStr\)/g, 'amountStr === "전부" ? BigInt(account.balance) : parseMoney(amountStr)');

// Replace amountStr === "전부" ? loan.current_amount : parseMoney(amountStr)
code = code.replace(/amountStr === "전부" \? loan\.current_amount : parseMoney\(amountStr\)/g, 'amountStr === "전부" ? BigInt(loan.current_amount) : parseMoney(amountStr)');

// Replace amountStr === "전부" ? hold.quantity : parseInt(args[2])
// This is for stock quantity, which is an integer, so it's fine.

// Replace totalCost = price * quantity with totalCost = BigInt(price) * BigInt(quantity)
code = code.replace(/const totalCost = stock\.price \* quantity;/g, 'const totalCost = BigInt(stock.price) * BigInt(quantity);');
code = code.replace(/const totalCost = device\.price \* quantity;/g, 'const totalCost = BigInt(device.price) * BigInt(quantity);');

// Replace totalCost = costPerExpansion * quantity with totalCost = BigInt(costPerExpansion) * BigInt(quantity)
code = code.replace(/const totalCost = costPerExpansion \* quantity;/g, 'const totalCost = BigInt(costPerExpansion) * BigInt(quantity);');

// Replace cost = 100000000 with cost = 100000000n
code = code.replace(/const cost = 100000000;/g, 'const cost = 100000000n;');
code = code.replace(/const costPerExpansion = 100000000;/g, 'const costPerExpansion = 100000000n;');

// Replace amount * 0.5 with (amount * 5n) / 10n
code = code.replace(/amount \* 0\.5/g, '(amount * 5n) / 10n');
code = code.replace(/device\.price \* 0\.5/g, '(BigInt(device.price) * 5n) / 10n');

// Replace btc_balance * 100000000 with BigInt(Math.floor(btc_balance * 100000000))
code = code.replace(/const totalCost = quantity \* 100000000;/g, 'const totalCost = BigInt(quantity) * 100000000n;');

fs.writeFileSync('server_refactored2.ts', code);
console.log('Refactored code written to server_refactored2.ts');

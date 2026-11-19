import * as fs from 'fs';

let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(
  /const total = Object\.values\(scores\)\.reduce\(\(sum: number, val: any\) => sum \+ Number\(val \|\| 0\), 0\) \+ Number\(bonus\);/g,
  "const total = (Object.values(scores).reduce((sum: number, val: any) => sum + Number(val || 0), 0) as number) + Number(bonus);"
);

code = code.replace(
  /const subtotal = \['aces','deuces','threes','fours','fives','sixes'\]\.reduce\(\(sum, k\) => sum \+ \(gameState\.scores\[k\] \|\| 0\), 0\);/g,
  "const subtotal = ['aces','deuces','threes','fours','fives','sixes'].reduce((sum: number, k) => sum + Number(gameState.scores[k] || 0), 0);"
);

code = code.replace(
  /const total = Object\.values\(gameState\.scores\)\.reduce\(\(sum: any, val: any\) => sum \+ \(val \|\| 0\), 0\) \+ bonus;/g,
  "const total = (Object.values(gameState.scores).reduce((sum: number, val: any) => sum + Number(val || 0), 0) as number) + Number(bonus);"
);

fs.writeFileSync('server.ts', code);
console.log('Fixed subtotal and total TS errors again!');

import express from "express";
import { createServer as createViteServer } from "vite";
import { Client, GatewayIntentBits, Events, TextChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType } from "discord.js";
import * as dotenv from "dotenv";
import Database from "better-sqlite3";
import path from "path";

dotenv.config();

const app = express();
const PORT = 3000;

// --- 로그 시스템 ---
const logs: string[] = [];
function addLog(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  const entry = `[${timestamp}] ${message}`;
  logs.push(entry);
  if (logs.length > 50) logs.shift();
  console.log(entry);
}

async function sendChunkedMessage(message: any, text: string) {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let currentChunk = "";
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.startsWith("```")) inCodeBlock = !inCodeBlock;

    if (currentChunk.length + line.length + 1 > 1900) {
      if (inCodeBlock) currentChunk += "```\n";
      chunks.push(currentChunk);
      currentChunk = inCodeBlock ? "```\n" + line + "\n" : line + "\n";
    } else {
      currentChunk += line + "\n";
    }
  }
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk);
  }

  if (chunks.length === 0) return;
  if (chunks.length === 1) {
    return message.reply(chunks[0]);
  }

  let currentPage = 0;

  const getRow = (page: number) => {
    const row = new ActionRowBuilder<ButtonBuilder>();
    row.addComponents(
      new ButtonBuilder()
        .setCustomId("prev_page")
        .setLabel("◀ 이전")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId("page_indicator")
        .setLabel(`${page + 1} / ${chunks.length}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId("next_page")
        .setLabel("다음 ▶")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === chunks.length - 1)
    );
    return row;
  };

  const sentMessage = await message.reply({
    content: chunks[currentPage],
    components: [getRow(currentPage)]
  });

  const collector = sentMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 300000 // 5 minutes
  });

  collector.on("collect", async (i: any) => {
    if (i.user.id !== message.author.id) {
      return i.reply({ content: "명령어를 입력한 사용자만 조작할 수 있습니다.", ephemeral: true });
    }

    if (i.customId === "prev_page") {
      currentPage--;
    } else if (i.customId === "next_page") {
      currentPage++;
    }

    await i.update({
      content: chunks[currentPage],
      components: [getRow(currentPage)]
    });
  });

  collector.on("end", () => {
    sentMessage.edit({ components: [] }).catch(() => {});
  });
}

// --- 데이터베이스 초기화 ---

import fs from "fs";
if (!fs.existsSync(".data")) {
  fs.mkdirSync(".data");
}

let db: any;
try {
  db = new Database(".data/economy.db");
  db.pragma('journal_mode = WAL'); // 데이터베이스 손상 방지 및 성능 향상을 위한 WAL 모드 활성화
  
  // BigInt 계산을 위한 SQLite 커스텀 함수 등록
  db.function('addBigInt', (a, b) => (BigInt(a || 0) + BigInt(b || 0)).toString());
  db.function('subBigInt', (a, b) => (BigInt(a || 0) - BigInt(b || 0)).toString());
  db.function('mulBigInt', (a, b) => (BigInt(a || 0) * BigInt(b || 0)).toString());
  db.function('divBigInt', (a, b) => (BigInt(a || 0) / BigInt(b || 1)).toString());
  db.function('applyInterest', (balance, rate) => {
    const b = BigInt(balance || 0);
    const r = Math.round(Number(rate) * 10000);
    return ((b * BigInt(10000 + r)) / 10000n).toString();
  });
  
  // 테이블 생성 (초기 스키마)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, 
      last_daily TEXT,
      penalty_until TEXT,
      btc_balance REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS stocks (
      symbol TEXT PRIMARY KEY, 
      name TEXT, 
      price INTEGER, 
      last_price INTEGER
    );
    CREATE TABLE IF NOT EXISTS stock_history (
      symbol TEXT,
      price INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS mining_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      price INTEGER,
      hash_rate REAL
    );
    CREATE TABLE IF NOT EXISTS user_miners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT,
      deviceId INTEGER,
      purchase_date DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS portfolio (
      userId TEXT, 
      symbol TEXT, 
      quantity INTEGER, 
      totalCost INTEGER DEFAULT 0, 
      PRIMARY KEY (userId, symbol)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, 
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS bank_accounts (
      userId TEXT, 
      bankId INTEGER, 
      balance TEXT DEFAULT '0', 
      account_number TEXT UNIQUE, 
      PRIMARY KEY (userId, bankId)
    );
    CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, 
      userId TEXT, 
      bankId INTEGER, 
      principal TEXT, 
      current_amount TEXT, 
      due_date TEXT
    );
    CREATE TABLE IF NOT EXISTS stock_alerts (
      userId TEXT,
      channelId TEXT,
      symbol TEXT,
      PRIMARY KEY (userId, symbol)
    );
    CREATE TABLE IF NOT EXISTS allowed_channels (
      channelId TEXT PRIMARY KEY
    );
  `);
  
  // 개별 컬럼 추가 (마이그레이션)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  
  // portfolio.totalCost
  try { db.prepare("ALTER TABLE portfolio ADD COLUMN totalCost INTEGER DEFAULT 0").run(); } catch(e) {}
  // users.btc_balance
  try { db.prepare("ALTER TABLE users ADD COLUMN btc_balance REAL DEFAULT 0").run(); } catch(e) {}

  // Migrate BTC from portfolio to users.btc_balance
  try {
    const btcHolds = db.prepare("SELECT * FROM portfolio WHERE symbol = 'BTC'").all();
    btcHolds.forEach((hold: any) => {
      db.prepare("INSERT OR IGNORE INTO users (id, btc_balance) VALUES (?, 0)").run(hold.userId);
      db.prepare("UPDATE users SET btc_balance = btc_balance + ? WHERE id = ?").run(hold.quantity, hold.userId);
      db.prepare("DELETE FROM portfolio WHERE userId = ? AND symbol = 'BTC'").run(hold.userId);
    });
  } catch (e) {
    console.error("BTC Migration Error:", e);
  }
  // stocks.reset_price
  try { db.prepare("ALTER TABLE stocks ADD COLUMN reset_price INTEGER").run(); } catch(e) {}
  db.prepare("UPDATE stocks SET reset_price = price WHERE reset_price IS NULL").run();
  // users.miner_slots
  try { db.prepare("ALTER TABLE users ADD COLUMN miner_slots INTEGER DEFAULT 10").run(); } catch(e) {}
  // users.title
  try { db.prepare("ALTER TABLE users ADD COLUMN title TEXT DEFAULT ''").run(); } catch(e) {}
  
  // 초기 채굴 기기 데이터 (업데이트를 위해 기존 데이터 삭제 후 재삽입)
  db.prepare("DELETE FROM mining_devices").run();
  // AUTOINCREMENT 초기화 (기존 기기 ID 유지)
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name='mining_devices'").run(); } catch(e) {}
  const devices = [
    { name: "GTX 1660 Super (중고)", price: 200000, hash: 0.000035 },
    { name: "RTX 3060 Ti", price: 500000, hash: 0.0001 },
    { name: "RTX 4070 Super", price: 1000000, hash: 0.00025 },
    { name: "RTX 4090", price: 3000000, hash: 0.0009 },
    { name: "Antminer S9 (구형 채굴기)", price: 8000000, hash: 0.003 },
    { name: "Antminer S19 Pro", price: 20000000, hash: 0.009 },
    { name: "Antminer S21", price: 50000000, hash: 0.025 },
    { name: "채굴 전용 서버 랙", price: 150000000, hash: 0.0875 },
    { name: "산업용 채굴 컨테이너", price: 500000000, hash: 0.333 },
    { name: "차세대 양자 채굴 시스템", price: 1500000000, hash: 1.25 },
    { name: "블랙홀 에너자이저", price: 5000000000, hash: 4.5 },
    { name: "다이슨 스피어 채굴기", price: 20000000000, hash: 20.0 },
    { name: "은하계 코어 채굴망", price: 100000000000, hash: 110.0 },
  ];
  const insertDevice = db.prepare("INSERT INTO mining_devices (name, price, hash_rate) VALUES (?, ?, ?)");
  devices.forEach(d => insertDevice.run(d.name, d.price, d.hash));
  
  // 기본 설정 및 주식 데이터
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run("update_interval", "60");
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run("fluctuation_range", "5");
  
  const initialStocks = [
    { symbol: "SAMSUNG", name: "삼성전자", price: 70000 },
    { symbol: "APPLE", name: "애플", price: 250000 },
    { symbol: "BTC", name: "비트코인", price: 100000000 },
  ];
  const insertStock = db.prepare("INSERT OR IGNORE INTO stocks (symbol, name, price, last_price) VALUES (?, ?, ?, ?)");
  initialStocks.forEach(s => insertStock.run(s.symbol, s.name, s.price, s.price));
  
  addLog("데이터베이스 준비 완료");
} catch (err: any) {
  addLog(`데이터베이스 오류: ${err.message}`);
}

// --- 주식 시세 변동 로직 ---
let stockInterval: NodeJS.Timeout;

function updateStockPrices() {
  try {
    const settings = db.prepare("SELECT * FROM settings").all();
    const rangeSetting = settings.find((s: any) => s.key === "fluctuation_range");
    const range = (rangeSetting ? parseInt(rangeSetting.value) : 5) / 100;
    
    const stocks = db.prepare("SELECT * FROM stocks").all();
    stocks.forEach((s: any) => {
      // 기본 변동 폭에 아주 미세한 상승 편향(+0.5%)을 추가하여 하락만 하는 현상 방지
      const drift = 0.005; 
      let changePercent = (Math.random() * (range * 2) - range) + drift;
      
      // 최대 25% 상승 제한
      if (changePercent > 0.25) {
        changePercent = 0.25;
      }
      
      // Math.floor 대신 Math.round를 사용하여 소수점 반올림 처리 (하락 편향 제거)
      let newPrice = Math.round(s.price * (1 + changePercent));
      
      // 가격이 너무 안 변하는 것을 방지 (최소 10원, 혹은 1% 이상 변동 유도)
      if (newPrice === s.price) {
        newPrice += Math.random() > 0.5 ? 10 : -10;
      }
      
      // 최대 25% 상승 제한 (강제)
      if (newPrice > s.price * 1.25) {
        newPrice = Math.round(s.price * 1.25);
      }
      
      newPrice = Math.max(10, newPrice);
      db.prepare("UPDATE stocks SET last_price = ?, price = ? WHERE symbol = ?").run(s.price, newPrice, s.symbol);
      db.prepare("INSERT INTO stock_history (symbol, price) VALUES (?, ?)").run(s.symbol, newPrice);
      
      if (newPrice !== s.price) {
        const alerts = db.prepare("SELECT * FROM stock_alerts WHERE symbol = ?").all(s.symbol);
        const channelAlerts = new Map<string, string[]>();
        for (const alert of alerts as any[]) {
          if (!channelAlerts.has(alert.channelId)) channelAlerts.set(alert.channelId, []);
          channelAlerts.get(alert.channelId)!.push(alert.userId);
        }
        
        for (const [channelId, users] of channelAlerts.entries()) {
          if (!client.isReady()) continue;
          client.channels.fetch(channelId).then(channel => {
            if (channel && channel.isTextBased()) {
              const diff = newPrice - s.price;
              const sign = diff > 0 ? "🔺" : diff < 0 ? "🔻" : "➖";
              const mentions = users.map(u => `<@${u}>`).join(" ");
              (channel as TextChannel).send(`${mentions} 🔔 **${s.name}(${s.symbol})** 주가 변동 알림: ${formatMoney(s.price)}원 ➡️ **${newPrice.toLocaleString()}원** (${sign} ${Math.abs(diff).toLocaleString()}원)`);
            }
          }).catch(err => {
            addLog(`알림 채널(${channelId}) 가져오기 오류: ${err.message}`);
          });
        }
      }
    });
    addLog("주식 시세가 업데이트되었습니다.");
  } catch (err: any) {
    addLog(`주식 업데이트 오류: ${err.message}`);
  }
}

function startStockTimer() {
  if (stockInterval) clearInterval(stockInterval);
  const row = db.prepare("SELECT value FROM settings WHERE key = 'update_interval'").get();
  const seconds = row ? parseInt(row.value) : 60;
  stockInterval = setInterval(updateStockPrices, seconds * 1000);
  addLog(`주식 타이머 시작: ${seconds}초 간격`);
}

// 초기 타이머 시작
setTimeout(startStockTimer, 5000);

// --- 은행 및 대출 이자 로직 (30분 주기) ---
function updateBankAndLoans() {
  try {
    const now = new Date();
    
    // 1. 예금 이자 지급 (1번: 3%, 2번: 2%, 3번: 1%)
    const savingsRates = { 1: 0.03, 2: 0.02, 3: 0.01 };
    for (const [bankId, rate] of Object.entries(savingsRates)) {
      db.prepare("UPDATE bank_accounts SET balance = applyInterest(balance, ?) WHERE bankId = ?").run(rate, bankId);
    }

    // 2. 대출 이자 가산 및 연체 처리
    const loans = db.prepare("SELECT * FROM loans").all();
    for (const loan of loans) {
      const dueDate = new Date(loan.due_date);
      
      // 연체 체크
      if (now > dueDate) {
        addLog(`연체 발생: ${loan.userId} (은행 ${loan.bankId})`);
        
        // 연체 발생 시 계좌 잔액 0으로 압류 (계좌 자체는 유지)
        db.prepare("UPDATE bank_accounts SET balance = '0' WHERE userId = ? AND bankId = ?").run(loan.userId, loan.bankId);
        
        const penaltyDate = new Date();
        penaltyDate.setDate(penaltyDate.getDate() + 3);
        db.prepare("UPDATE users SET penalty_until = ? WHERE id = ?").run(penaltyDate.toISOString(), loan.userId);
        db.prepare("DELETE FROM loans WHERE id = ?").run(loan.id);
        continue;
      }

      // 대출 이자 계산 (1번: 10%, 2번: 7%, 3번: 5%)
      let loanRate = 0.08; // 기본 8%
      if (loan.bankId === 1) loanRate = 0.10;
      else if (loan.bankId === 2) loanRate = 0.07;
      else if (loan.bankId === 3) loanRate = 0.05;
      
      db.prepare("UPDATE loans SET current_amount = applyInterest(current_amount, ?) WHERE id = ?").run(loanRate, loan.id);
    }
    addLog("은행 예금 이자 및 대출 이자가 정산되었습니다.");
  } catch (err: any) {
    addLog(`은행 정산 오류: ${err.message}`);
  }
}

let bankInterval: NodeJS.Timeout;
function startBankTimer() {
  if (bankInterval) clearInterval(bankInterval);
  const row = db.prepare("SELECT value FROM settings WHERE key = 'bank_interval'").get();
  const minutes = row ? parseInt(row.value) : 30;
  bankInterval = setInterval(updateBankAndLoans, minutes * 60 * 1000);
  addLog(`은행 이자 타이머 시작: ${minutes}분 간격`);
}
setTimeout(startBankTimer, 5000);

// --- 채굴 로직 (설정된 주기마다 실행) ---
function mineBTC() {
  try {
    const minersList = db.prepare(`
      SELECT um.userId, SUM(d.hash_rate) as total_hash 
      FROM user_miners um 
      JOIN mining_devices d ON um.deviceId = d.id 
      GROUP BY um.userId
    `).all();
    
    for (const miner of minersList) {
      if (miner.total_hash > 0) {
        // Ensure user exists in users table
        db.prepare("INSERT OR IGNORE INTO users (id, btc_balance) VALUES (?, 0)").run(miner.userId);
        
        // Update balance
        db.prepare("UPDATE users SET btc_balance = btc_balance + ? WHERE id = ?").run(miner.total_hash, miner.userId);
      }
    }
    addLog("BTC 채굴이 완료되었습니다.");
  } catch (err: any) {
    addLog(`채굴 오류: ${err.message}`);
  }
}

let mineInterval: NodeJS.Timeout;
function startMineTimer() {
  if (mineInterval) clearInterval(mineInterval);
  const row = db.prepare("SELECT value FROM settings WHERE key = 'mine_interval'").get();
  const minutes = row ? parseInt(row.value) : 10;
  mineInterval = setInterval(mineBTC, minutes * 60 * 1000);
  addLog(`채굴 타이머 시작: ${minutes}분 간격`);
}
setTimeout(startMineTimer, 5000);

// --- 주식 정기 초기화 로직 (04:00, 12:00) ---
function resetStocks() {
  try {
    const stocks = db.prepare("SELECT * FROM stocks").all();
    stocks.forEach((s: any) => {
      const resetPrice = s.reset_price || 10000;
      db.prepare("UPDATE stocks SET last_price = ?, price = ? WHERE symbol = ?").run(resetPrice, resetPrice, s.symbol);
      db.prepare("INSERT INTO stock_history (symbol, price) VALUES (?, ?)").run(s.symbol, resetPrice);
    });
    addLog("주식 가격이 정해진 초기값으로 리셋되었습니다.");
  } catch (err: any) {
    addLog(`주식 리셋 오류: ${err.message}`);
  }
}

let lastResetHour = -1;
setInterval(() => {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  
  const resetSetting = db.prepare("SELECT value FROM settings WHERE key = 'stock_reset_hours'").get();
  let resetHours = [4, 12]; // 기본값: 오전 4시, 오후 12시
  if (resetSetting) {
    try {
      resetHours = JSON.parse(resetSetting.value);
    } catch (e) {
      resetHours = [4, 12];
    }
  }
  
  if (resetHours.includes(hours) && minutes === 0) {
    if (lastResetHour !== hours) {
      resetStocks();
      lastResetHour = hours;
    }
  } else {
    if (!resetHours.includes(hours)) {
      lastResetHour = -1;
    }
  }
}, 30000); // 30초마다 시간 체크


function parseMoney(str: string): bigint | null {
  try {
    const val = BigInt(str.replace(/,/g, ''));
    return val;
  } catch {
    return null;
  }
}
function formatMoney(val: any): string {
  try {
    if (val === null || val === undefined) return "0";
    return BigInt(val.toString()).toLocaleString();
  } catch {
    return "0";
  }
}

// --- 은행 유틸리티 ---
function getPrimaryAccount(userId: string) {
  // 1번 -> 2번 -> 3번 순으로 계좌를 찾음
  return db.prepare("SELECT * FROM bank_accounts WHERE userId = ? ORDER BY bankId ASC LIMIT 1").get(userId);
}

function depositToBank(userId: string, amount: number) {
  const account = getPrimaryAccount(userId);
  if (!account) return false;
  db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE userId = ? AND bankId = ?").run(amount, userId, account.bankId);
  return true;
}

function withdrawFromBank(userId: string, amount: number) {
  // 잔액이 충분한 첫 번째 계좌에서 출금
  const accounts = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? ORDER BY bankId ASC").all(userId);
  for (const acc of accounts) {
    if (acc.balance >= amount) {
      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE userId = ? AND bankId = ?").run(amount, userId, acc.bankId);
      return true;
    }
  }
  return false;
}

function getTotalBankBalance(userId: string) {
  const row = db.prepare("SELECT SUM(balance) as total FROM bank_accounts WHERE userId = ?").get(userId);
  return row?.total || 0;
}

// --- 블랙잭 유틸리티 ---
const activeBlackjacks = new Map<string, any>();
const activeDuels = new Map<string, any>(); // PvP 대결 저장용

function getDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const deck = [];
  for (const suit of suits) {
    for (const value of values) {
      deck.push({ suit, value });
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

function calculateScore(cards: any[]) {
  let score = 0;
  let aces = 0;
  for (const card of cards) {
    if (['J', 'Q', 'K'].includes(card.value)) score += 10;
    else if (card.value === 'A') { score += 11; aces += 1; }
    else score += parseInt(card.value);
  }
  while (score > 21 && aces > 0) {
    score -= 10;
    aces -= 1;
  }
  return score;
}

// --- 포커 유틸리티 ---
const activePokers = new Map<string, any>();

function evaluatePokerHand(hand: any[]) {
  const values = hand.map(c => c.value);
  const suits = hand.map(c => c.suit);
  
  const valueCounts: Record<string, number> = {};
  values.forEach(v => valueCounts[v] = (valueCounts[v] || 0) + 1);
  
  const isFlush = new Set(suits).size === 1;
  
  const order = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const sortedIndices = values.map(v => order.indexOf(v)).sort((a, b) => a - b);
  
  let isStraight = true;
  for (let i = 0; i < 4; i++) {
    if (sortedIndices[i+1] - sortedIndices[i] !== 1) {
      isStraight = false;
      break;
    }
  }
  // 백스트레이트 (A,2,3,4,5) 예외 처리
  if (!isStraight && sortedIndices.join(',') === '0,1,2,3,12') isStraight = true;

  const counts = Object.values(valueCounts).sort((a, b) => b - a);
  
  if (isFlush && isStraight) {
    if (sortedIndices.includes(12) && sortedIndices.includes(11)) return { name: "로얄 플러쉬", mult: 250 };
    return { name: "스트레이트 플러쉬", mult: 50 };
  }
  if (counts[0] === 4) return { name: "포카드", mult: 25 };
  if (counts[0] === 3 && counts[1] === 2) return { name: "풀하우스", mult: 9 };
  if (isFlush) return { name: "플러쉬", mult: 6 };
  if (isStraight) return { name: "스트레이트", mult: 4 };
  if (counts[0] === 3) return { name: "트리플", mult: 3 };
  if (counts[0] === 2 && counts[1] === 2) return { name: "투페어", mult: 2 };
  if (counts[0] === 2 && ['J','Q','K','A'].includes(Object.keys(valueCounts).find(k => valueCounts[k] === 2)!)) return { name: "원페어 (J 이상)", mult: 1 };
  
  return { name: "하이카드 (꽝)", mult: 0 };
}

// --- 야추 다이스 유틸리티 ---
const activeYachts = new Map<string, any>();

function calculateYachtScore(dice: number[], category: string): number {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  let sum = 0;
  for (const d of dice) {
    counts[d]++;
    sum += d;
  }
  
  switch (category) {
    case 'aces': return counts[1] * 1;
    case 'deuces': return counts[2] * 2;
    case 'threes': return counts[3] * 3;
    case 'fours': return counts[4] * 4;
    case 'fives': return counts[5] * 5;
    case 'sixes': return counts[6] * 6;
    case 'choice': return sum;
    case 'four_of_a_kind': return counts.some(c => c >= 4) ? sum : 0;
    case 'full_house': return (counts.includes(3) && counts.includes(2)) || counts.includes(5) ? sum : 0;
    case 'small_straight': 
      const s = counts.slice(1).map(c => c > 0 ? '1' : '0').join('');
      return s.includes('1111') ? 15 : 0;
    case 'large_straight':
      const s2 = counts.slice(1).map(c => c > 0 ? '1' : '0').join('');
      return s2.includes('11111') ? 30 : 0;
    case 'yacht': return counts.includes(5) ? 50 : 0;
  }
  return 0;
}

function buildYachtUI(gameState: any) {
  const { dice, held, rollsLeft, turn, scores, amount } = gameState;
  
  const diceEmojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣'];
  const diceStr = dice.map((d: number, i: number) => held[i] ? `[🔒 ${diceEmojis[d-1]}]` : `[ ${diceEmojis[d-1]} ]`).join(' ');

  const s = (key: string) => scores[key] !== null ? scores[key] : '-';
  const subtotal = ['aces','deuces','threes','fours','fives','sixes'].reduce((sum: number, k) => sum + Number(scores[k] || 0), 0);
  const bonus = subtotal >= 63 ? 35 : 0;
  const total = (Object.values(scores).reduce((sum: number, val: any) => sum + Number(val || 0), 0) as number) + Number(bonus);

  let content = `🎲 **야추 다이스 (Turn ${turn}/12)** | 💰 베팅: ${formatMoney(amount)}원\n`;
  content += `남은 굴리기: **${rollsLeft}번**\n\n`;
  content += `현재 주사위: ${diceStr}\n\n`;
  content += `\`\`\`\n[점수판]\n`;
  content += `Aces: ${s('aces')} | Deuces: ${s('deuces')} | Threes: ${s('threes')}\n`;
  content += `Fours: ${s('fours')} | Fives: ${s('fives')} | Sixes: ${s('sixes')}\n`;
  content += `(Subtotal: ${subtotal}/63) -> Bonus: ${bonus}\n`;
  content += `Choice: ${s('choice')} | 4 of a Kind: ${s('four_of_a_kind')} | Full House: ${s('full_house')}\n`;
  content += `S.Straight: ${s('small_straight')} | L.Straight: ${s('large_straight')} | Yacht: ${s('yacht')}\n`;
  content += `\n총점: ${total}점\n\`\`\``;

  const row1 = new ActionRowBuilder<ButtonBuilder>();
  for (let i = 0; i < 5; i++) {
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(`yacht_dice_${i}`)
        .setLabel(`${i+1}번 주사위`)
        .setStyle(held[i] ? ButtonStyle.Success : ButtonStyle.Secondary)
    );
  }

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('yacht_roll')
      .setLabel('🎲 남은 주사위 굴리기')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(rollsLeft <= 0)
  );

  const categoryNames: Record<string, string> = {
    aces: 'Aces (1의 합)', deuces: 'Deuces (2의 합)', threes: 'Threes (3의 합)',
    fours: 'Fours (4의 합)', fives: 'Fives (5의 합)', sixes: 'Sixes (6의 합)',
    choice: 'Choice (모든 합)', four_of_a_kind: '4 of a Kind (4개 동일)',
    full_house: 'Full House (3개+2개 동일)', small_straight: 'S.Straight (4개 연속)',
    large_straight: 'L.Straight (5개 연속)', yacht: 'Yacht (5개 동일)'
  };

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('yacht_score')
    .setPlaceholder('이 턴의 점수를 기록할 항목을 선택하세요');

  let optionCount = 0;
  for (const [key, name] of Object.entries(categoryNames)) {
    if (scores[key] === null) {
      const previewScore = calculateYachtScore(dice, key);
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(name)
          .setDescription(`예상 점수: ${previewScore}점`)
          .setValue(key)
      );
      optionCount++;
    }
  }

  const components: any[] = [row1, row2];
  if (optionCount > 0) {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));
  }

  return { content, components };
}

// --- 디스코드 봇 설정 ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

let botStatus = "오프라인";
let botUser: any = null;

client.on(Events.ClientReady, (c) => {
  botStatus = "온라인";
  botUser = {
    username: c.user.username,
    tag: c.user.tag,
    avatar: c.user.displayAvatarURL(),
  };
  addLog(`봇 로그인 성공: ${c.user.tag}`);
});

client.on(Events.ShardDisconnect, () => {
  botStatus = "연결 끊김";
  addLog("디스코드 서버와 연결이 끊겼습니다.");
});

client.on(Events.ShardReconnecting, () => {
  botStatus = "재연결 중";
  addLog("디스코드 서버에 재연결을 시도하고 있습니다...");
});

client.on(Events.Error, (err) => {
  addLog(`디스코드 클라이언트 에러: ${err.message}`);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
  
  if (interaction.isButton() && (interaction.customId === 'bj_hit' || interaction.customId === 'bj_stand')) {
    const gameState = activeBlackjacks.get(interaction.user.id);
    if (!gameState) {
      return interaction.reply({ content: "❌ 진행 중인 게임이 없거나 본인의 게임이 아닙니다.", ephemeral: true });
    }

    if (interaction.customId === 'bj_hit') {
      gameState.playerHand.push(gameState.deck.pop());
      const playerScore = calculateScore(gameState.playerHand);
      
      if (playerScore > 21) {
        activeBlackjacks.delete(interaction.user.id);
        return interaction.update({
          content: `💥 **버스트! (21 초과)** 플레이어 패배...\n\n👤 **플레이어 (${playerScore})**: ${gameState.playerHand.map((c:any) => c.suit + c.value).join(', ')}\n💸 **${formatMoney(gameState.amount)}원**을 잃었습니다.`,
          components: []
        });
      } else {
        const dealerVisibleScore = calculateScore([gameState.dealerHand[0]]);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('bj_hit').setLabel('히트 (카드 받기)').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('bj_stand').setLabel('스탠드 (멈춤)').setStyle(ButtonStyle.Danger)
        );
        return interaction.update({
          content: `🃏 **블랙잭 진행 중** (베팅: ${formatMoney(gameState.amount)}원)\n\n👤 **플레이어 (${playerScore})**: ${gameState.playerHand.map((c:any) => c.suit + c.value).join(', ')}\n🤖 **딜러 (${dealerVisibleScore})**: ${gameState.dealerHand[0].suit + gameState.dealerHand[0].value}, ❓\n\n카드를 더 받으시겠습니까?`,
          components: [row]
        });
      }
    } else if (interaction.customId === 'bj_stand') {
      let dealerScore = calculateScore(gameState.dealerHand);
      while (dealerScore < 17) {
        gameState.dealerHand.push(gameState.deck.pop());
        dealerScore = calculateScore(gameState.dealerHand);
      }

      const playerScore = calculateScore(gameState.playerHand);
      let resultMsg = "";
      let winAmount = 0n;

      if (dealerScore > 21 || playerScore > dealerScore) {
        winAmount = gameState.amount * 2n;
        resultMsg = `🎉 **플레이어 승리!** **${winAmount.toLocaleString()}원** 획득!`;
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, gameState.accNum);
      } else if (playerScore === dealerScore) {
        winAmount = gameState.amount;
        resultMsg = `🤝 **무승부!** 베팅금 **${winAmount.toLocaleString()}원**을 돌려받았습니다.`;
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, gameState.accNum);
      } else {
        resultMsg = `💸 **딜러 승리...** **${formatMoney(gameState.amount)}원**을 잃었습니다.`;
      }

      activeBlackjacks.delete(interaction.user.id);
      return interaction.update({
        content: `${resultMsg}\n\n👤 **플레이어 (${playerScore})**: ${gameState.playerHand.map((c:any) => c.suit + c.value).join(', ')}\n🤖 **딜러 (${dealerScore})**: ${gameState.dealerHand.map((c:any) => c.suit + c.value).join(', ')}`,
        components: []
      });
    }
  }

  // 포커 카드 교체 로직
  if (interaction.customId.startsWith('poker_')) {
    const gameState = activePokers.get(interaction.user.id);
    if (!gameState) return interaction.reply({ content: "❌ 진행 중인 게임이 없거나 본인의 게임이 아닙니다.", ephemeral: true });

    if (interaction.customId === 'poker_done') {
      // 결과 계산
      const result = evaluatePokerHand(gameState.hand);
      let msg = `🃏 **비디오 포커 결과**\n\n최종 패: **${gameState.hand.map((c:any) => c.suit + c.value).join(' ')}**\n족보: **${result.name}**\n\n`;
      
      if (result.mult > 0) {
        const winAmount = gameState.amount * BigInt(result.mult);
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, gameState.accNum);
        msg += `🎉 **축하합니다! ${result.mult}배 당첨!** **${winAmount.toLocaleString()}원** 획득!`;
      } else {
        msg += `💸 **꽝...** 베팅금을 잃었습니다.`;
      }
      
      activePokers.delete(interaction.user.id);
      return interaction.update({ content: msg, components: [] });
    }

    if (interaction.customId === 'poker_draw') {
      // 선택하지 않은 카드 교체
      for (let i = 0; i < 5; i++) {
        if (!gameState.held[i]) {
          gameState.hand[i] = gameState.deck.pop();
        }
      }

      const result = evaluatePokerHand(gameState.hand);
      let msg = `🃏 **비디오 포커 결과**\n\n최종 패: **${gameState.hand.map((c:any) => c.suit + c.value).join(' ')}**\n족보: **${result.name}**\n\n`;
      
      if (result.mult > 0) {
        const winAmount = gameState.amount * BigInt(result.mult);
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, gameState.accNum);
        msg += `🎉 **축하합니다! ${result.mult}배 당첨!** **${winAmount.toLocaleString()}원** 획득!`;
      } else {
        msg += `💸 **꽝...** 베팅금을 잃었습니다.`;
      }
      
      activePokers.delete(interaction.user.id);
      return interaction.update({ content: msg, components: [] });
    }

    // 카드 교체 (토글)
    const idx = parseInt(interaction.customId.split('_')[1]);
    if (!isNaN(idx) && idx >= 0 && idx < 5) {
      gameState.held[idx] = !gameState.held[idx];
    }
    
    const row1 = new ActionRowBuilder<ButtonBuilder>();
    for (let i = 0; i < 5; i++) {
      const card = gameState.hand[i];
      const btn = new ButtonBuilder()
        .setCustomId(`poker_${i}`)
        .setLabel(card.suit + card.value)
        .setStyle(gameState.held[i] ? ButtonStyle.Success : ButtonStyle.Secondary);
      row1.addComponents(btn);
    }
    
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('poker_draw').setLabel('선택한 카드 유지하고 나머지 교체 (Draw)').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('poker_done').setLabel('그대로 승부 (Stand)').setStyle(ButtonStyle.Danger)
    );

    return interaction.update({ components: [row1, row2] });
  }

  // PvP 가위바위보 선택
  if (interaction.customId.startsWith('rps_')) {
    const [, duelId, choice] = interaction.customId.split('_');
    const duel = activeDuels.get(duelId);
    
    if (!duel || duel.type !== 'rps') return interaction.reply({ content: "❌ 만료되었거나 존재하지 않는 대결입니다.", ephemeral: true });
    if (interaction.user.id !== duel.p1 && interaction.user.id !== duel.p2) return interaction.reply({ content: "❌ 이 대결의 참가자가 아닙니다.", ephemeral: true });

    if (interaction.user.id === duel.p1) duel.p1Choice = choice;
    if (interaction.user.id === duel.p2) duel.p2Choice = choice;

    await interaction.reply({ content: `✅ **${choice}**를 선택했습니다! 상대방을 기다리는 중...`, ephemeral: true });

    if (duel.p1Choice && duel.p2Choice) {
      // 결과 판정
      let resultMsg = `✌️✊🖐️ **가위바위보 대결 결과**\n\n👤 <@${duel.p1}>: **${duel.p1Choice}** vs 👤 <@${duel.p2}>: **${duel.p2Choice}**\n\n`;
      
      if (duel.p1Choice === duel.p2Choice) {
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(duel.amount, duel.p1Acc);
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(duel.amount, duel.p2Acc);
        resultMsg += `🤝 **무승부!** 양쪽 모두 베팅금(${formatMoney(duel.amount)}원)을 돌려받았습니다.`;
      } else if (
        (duel.p1Choice === "가위" && duel.p2Choice === "보") ||
        (duel.p1Choice === "바위" && duel.p2Choice === "가위") ||
        (duel.p1Choice === "보" && duel.p2Choice === "바위")
      ) {
        const winAmount = duel.amount * 2n;
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, duel.p1Acc);
        resultMsg += `🎉 **<@${duel.p1}> 승리!** **${winAmount.toLocaleString()}원**을 획득했습니다! (패배자: <@${duel.p2}>)`;
      } else {
        const winAmount = duel.amount * 2n;
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, duel.p2Acc);
        resultMsg += `🎉 **<@${duel.p2}> 승리!** **${winAmount.toLocaleString()}원**을 획득했습니다! (패배자: <@${duel.p1}>)`;
      }

      activeDuels.delete(duelId);
      
      // 원래 메시지 찾아서 업데이트
      try {
        const channel = await client.channels.fetch(duel.channelId);
        if (channel?.isTextBased()) {
          const msg = await channel.messages.fetch(duel.messageId);
          if (msg) await msg.edit({ content: resultMsg, components: [] });
        }
      } catch (e) {
        addLog("PvP 결과 메시지 업데이트 실패");
      }
    }
  }

  // 야추 다이스 로직
  if (interaction.isButton() && interaction.customId.startsWith('yacht_dice_')) {
    const gameState = activeYachts.get(interaction.user.id);
    if (!gameState) return interaction.reply({ content: "❌ 진행 중인 게임이 없습니다.", ephemeral: true });
    const idx = parseInt(interaction.customId.split('_')[2]);
    gameState.held[idx] = !gameState.held[idx];
    return interaction.update(buildYachtUI(gameState));
  }

  if (interaction.isButton() && interaction.customId === 'yacht_roll') {
    const gameState = activeYachts.get(interaction.user.id);
    if (!gameState) return interaction.reply({ content: "❌ 진행 중인 게임이 없습니다.", ephemeral: true });
    if (gameState.rollsLeft <= 0) return interaction.reply({ content: "❌ 더 이상 굴릴 수 없습니다. 점수를 기록하세요.", ephemeral: true });
    
    for (let i = 0; i < 5; i++) {
      if (!gameState.held[i]) {
        gameState.dice[i] = Math.floor(Math.random() * 6) + 1;
      }
    }
    gameState.rollsLeft--;
    return interaction.update(buildYachtUI(gameState));
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'yacht_score') {
    const gameState = activeYachts.get(interaction.user.id);
    if (!gameState) return interaction.reply({ content: "❌ 진행 중인 게임이 없습니다.", ephemeral: true });
    
    const category = interaction.values[0];
    gameState.scores[category] = calculateYachtScore(gameState.dice, category);

    if (gameState.turn >= 12) {
      // Game Over
      const subtotal = ['aces','deuces','threes','fours','fives','sixes'].reduce((sum: number, k) => sum + Number(gameState.scores[k] || 0), 0);
      const bonus = subtotal >= 63 ? 35 : 0;
      const total = (Object.values(gameState.scores).reduce((sum: number, val: any) => sum + Number(val || 0), 0) as number) + Number(bonus);

      let mult = 0;
      if (total >= 300) mult = 50;
      else if (total >= 250) mult = 10;
      else if (total >= 200) mult = 5;
      else if (total >= 150) mult = 2;
      else if (total >= 100) mult = 1;

      let resultMsg = `🎲 **야추 다이스 종료!**\n최종 점수: **${total}점**\n\n`;
      if (mult > 0) {
        const winAmount = gameState.amount * BigInt(mult);
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, gameState.accNum);
        resultMsg += `🎉 **축하합니다! ${mult}배 당첨!** **${winAmount.toLocaleString()}원** 획득!`;
      } else {
        resultMsg += `💸 **아쉽습니다...** 100점을 넘지 못해 베팅금을 잃었습니다.`;
      }

      activeYachts.delete(interaction.user.id);
      const finalUI = buildYachtUI(gameState);
      finalUI.content = resultMsg + "\n\n" + finalUI.content;
      finalUI.components = []; // Remove buttons
      return interaction.update(finalUI);
    } else {
      // Next Turn
      gameState.turn++;
      gameState.rollsLeft = 2;
      gameState.held = [false, false, false, false, false];
      gameState.dice = [
        Math.floor(Math.random() * 6) + 1,
        Math.floor(Math.random() * 6) + 1,
        Math.floor(Math.random() * 6) + 1,
        Math.floor(Math.random() * 6) + 1,
        Math.floor(Math.random() * 6) + 1
      ];
      return interaction.update(buildYachtUI(gameState));
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // 모든 메시지 로그 기록 (디버깅용)
  addLog(`메시지 감지 - [${message.author.username}]: ${message.content}`);

  // 명령어가 아닌 일반 대화는 무시
  if (!message.content.startsWith("!")) return;

  const args = message.content.trim().split(/ +/);
  const command = args[0].toLowerCase();

  // Helper check for admin
  const checkAdmin = () => {
    if (message.member?.permissions.has("Administrator")) return true;
    const adminRecord = db.prepare("SELECT * FROM admins WHERE id = ?").get(message.author.id);
    return !!adminRecord;
  };

  if (command === "!관리자") {
    const isAdmin = checkAdmin();
    if (!isAdmin) return message.reply("❌ 관리자 권한이 필요합니다.");
    const action = args[1];
    const targetUser = message.mentions.users.first();
    
    if (!action || !targetUser) return message.reply("❌ 사용법: `!관리자 [추가/제거] [@유저멘션]`");
    
    if (action === "추가") {
      db.prepare("INSERT OR IGNORE INTO admins (id) VALUES (?)").run(targetUser.id);
      return message.reply(`✅ <@${targetUser.id}>님이 관리자로 추가되었습니다.`);
    } else if (action === "제거") {
      db.prepare("DELETE FROM admins WHERE id = ?").run(targetUser.id);
      return message.reply(`🚫 <@${targetUser.id}>님의 관리자 권한이 제거되었습니다.`);
    } else {
      return message.reply("❌ 사용법: `!관리자 [추가/제거] [@유저멘션]`");
    }
  }

  // --- 채널 제한 로직 ---
  if (command === "!채널설정") {
    const isAdmin = checkAdmin();
    if (!isAdmin) return message.reply("❌ 관리자 권한이 필요합니다.");
    
    const action = args[1];
    const channelId = message.channel.id;
    
    if (action === "등록") {
      db.prepare("INSERT OR IGNORE INTO allowed_channels (channelId) VALUES (?)").run(channelId);
      return message.reply("✅ 이 채널에서 봇이 작동하도록 설정되었습니다.");
    } else if (action === "해제") {
      db.prepare("DELETE FROM allowed_channels WHERE channelId = ?").run(channelId);
      return message.reply("🚫 이 채널에서 봇 작동이 해제되었습니다.");
    } else {
      return message.reply("❌ 사용법: `!채널설정 [등록/해제]`");
    }
  }

  const allowedChannels = db.prepare("SELECT channelId FROM allowed_channels").all();
  if (allowedChannels.length > 0) {
    const isAllowed = allowedChannels.some((row: any) => row.channelId === message.channel.id);
    if (!isAllowed) return; // 허용된 채널이 아니면 무시
  }

  try {
    // 관리자 무한 돈 (1경 = 10,000,000,000,000,000)
    if (checkAdmin()) {
      db.prepare("UPDATE bank_accounts SET balance = '10000000000000000' WHERE userId = ?").run(message.author.id);
    }

    // 페널티 체크
    const userRow = db.prepare("SELECT penalty_until FROM users WHERE id = ?").get(message.author.id);
    const isPenalized = userRow?.penalty_until && new Date(userRow.penalty_until) > new Date();

    // 계좌 필수 체크 (안녕, 은행 가입, 명령어 제외)
    const hasAnyAccount = db.prepare("SELECT 1 FROM bank_accounts WHERE userId = ?").get(message.author.id);
    const isBasicCommand = ["!안녕", "!은행", "!명령어"].includes(command);
    
    if (!hasAnyAccount && !isBasicCommand) {
      return message.reply("❌ 은행 계좌가 없습니다! 먼저 `!은행 가입 [1/2/3]` 명령어로 계좌를 개설해주세요.");
    }

    if (command === "!안녕") {
      message.reply("안녕하세요! 봇이 정상적으로 메시지를 읽고 있습니다.");
    }
    
    if (command === "!출석") {
      const userId = message.author.id;
      let user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
      if (!user) {
        db.prepare("INSERT INTO users (id) VALUES (?)").run(userId);
        user = { id: userId, last_daily: null };
      }
      const today = new Date().toDateString();
      if (user.last_daily === today) return message.reply("이미 오늘 출석하셨습니다.");
      
      const success = depositToBank(userId, 30000);
      if (!success) return message.reply("❌ 입금할 계좌를 찾을 수 없습니다. 먼저 `!은행 가입`을 해주세요.");
      
      db.prepare("UPDATE users SET last_daily = ? WHERE id = ?").run(today, userId);
      message.reply("✅ 출석 완료! 30,000원이 은행 계좌로 자동 입금되었습니다.");
    }

    if (command === "!돈") {
      const bankTotal = getTotalBankBalance(message.author.id);
      const user = db.prepare("SELECT btc_balance, title FROM users WHERE id = ?").get(message.author.id);
      const btc = user?.btc_balance || 0;
      const title = user?.title ? `[${user.title}] ` : "";
      message.reply(`💰 **${title}${message.author.username}**님의 자산 현황\n- 은행 잔고: **${bankTotal.toLocaleString()}원**\n- BTC 보유량: **${btc.toFixed(6)} BTC**`);
    }

    // --- 상점 명령어 ---
    if (command === "!상점") {
      const sub = args[1];
      if (!sub) {
        let reply = "🛒 **아이템 상점**\n```\n";
        reply += "[1] 칭호: 부자 (가격: 5억 원)\n";
        reply += "[2] 칭호: 재벌 (가격: 50억 원)\n";
        reply += "[3] 칭호: 우주만수르 (가격: 500억 원)\n";
        reply += "```\n사용법: `!상점 구매 [번호] [내계좌번호]`";
        return await sendChunkedMessage(message, reply);
      }

      if (sub === "구매") {
        const itemId = args[2];
        const accNum = args[3];
        if (!itemId || !accNum) return message.reply("❌ 사용법: `!상점 구매 [번호] [내계좌번호]`");

        const items: Record<string, {name: string, price: number}> = {
          "1": { name: "부자", price: 500000000 },
          "2": { name: "재벌", price: 5000000000 },
          "3": { name: "우주만수르", price: 50000000000 }
        };

        const item = items[itemId];
        if (!item) return message.reply("❌ 존재하지 않는 아이템 번호입니다.");

        const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
        if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
        if (account.balance < item.price) return message.reply(`❌ 계좌 잔액이 부족합니다. (가격: ${formatMoney(item.price)}원)`);

        db.prepare("INSERT OR IGNORE INTO users (id) VALUES (?)").run(message.author.id);
        db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(item.price, accNum);
        db.prepare("UPDATE users SET title = ? WHERE id = ?").run(item.name, message.author.id);

        message.reply(`✅ **[${item.name}]** 칭호를 구매하여 장착했습니다! (\`!돈\` 명령어로 확인해보세요)`);
      }
    }

    // --- 주식 명령어 ---
    if (command === "!주식알림") {
      const sub = args[1];
      const symbol = args[2]?.toUpperCase();
      
      if (!sub || !symbol || !["켜기", "끄기"].includes(sub)) {
        return message.reply("❌ 사용법: `!주식알림 켜기 [종목코드]` 또는 `!주식알림 끄기 [종목코드]`\n예: `!주식알림 켜기 MC`");
      }

      const stock = db.prepare("SELECT * FROM stocks WHERE symbol = ?").get(symbol);
      if (!stock) return message.reply("❌ 존재하지 않는 종목입니다.");

      if (sub === "켜기") {
        try {
          db.prepare("INSERT INTO stock_alerts (userId, channelId, symbol) VALUES (?, ?, ?)").run(message.author.id, message.channel.id, symbol);
          message.reply(`✅ **${stock.name}(${symbol})** 주식 알림이 켜졌습니다. 주가가 변동될 때마다 이 채널로 알림이 옵니다.`);
        } catch (e) {
          message.reply("⚠️ 이미 해당 종목의 알림이 켜져 있습니다.");
        }
      } else if (sub === "끄기") {
        const info = db.prepare("DELETE FROM stock_alerts WHERE userId = ? AND symbol = ?").run(message.author.id, symbol);
        if (info.changes > 0) {
          message.reply(`✅ **${stock.name}(${symbol})** 주식 알림이 꺼졌습니다.`);
        } else {
          message.reply("⚠️ 해당 종목의 알림이 켜져 있지 않습니다.");
        }
      }
    }

    if (command === "!주식" && args[1] !== "그래프") {
      const stocks = db.prepare("SELECT * FROM stocks").all();
      let reply = "📈 **현재 주식 시세**\n```\n";
      stocks.forEach((s: any) => {
        const diff = s.price - s.last_price;
        const sign = diff >= 0 ? "+" : "";
        reply += `${s.name}(${s.symbol}): ${formatMoney(s.price)}원 (${sign}${diff.toLocaleString()}원)\n`;
      });
      reply += "```\n사용법: `!매수 [코드] [수량]`, `!매도 [코드] [수량]`, `!주식 그래프 [코드]`";
      await sendChunkedMessage(message, reply);
    }

    if (command === "!주식" && args[1] === "그래프") {
      const symbol = args[2]?.toUpperCase();
      if (!symbol) return message.reply("❌ 사용법: `!주식 그래프 [코드]`");
      
      const stock = db.prepare("SELECT * FROM stocks WHERE symbol = ?").get(symbol);
      if (!stock) return message.reply("❌ 존재하지 않는 종목입니다.");

      const history = db.prepare("SELECT price FROM stock_history WHERE symbol = ? ORDER BY timestamp DESC LIMIT 15").all(symbol).reverse();
      if (history.length < 2) return message.reply("❌ 아직 그래프를 그릴 만큼 데이터가 쌓이지 않았습니다.");

      const prices = history.map((h: any) => h.price);
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const range = max - min || 1;

      let graph = `📊 **${stock.name}(${symbol})** 최근 시세 그래프\n\`\`\`\n`;
      const height = 5;
      for (let y = height; y >= 0; y--) {
        let line = "";
        const threshold = min + (range / height) * y;
        prices.forEach((p: number) => {
          line += p >= threshold ? "■ " : "  ";
        });
        graph += line + "\n";
      }
      graph += "------------------------------\n";
      graph += `최고: ${max.toLocaleString()}원 | 최저: ${min.toLocaleString()}원\n`;
      graph += "```";
      return message.reply(graph);
    }

    if (command === "!매수") {
      if (isPenalized) return message.reply(`❌ 페널티 기간 중에는 주식 거래가 불가능합니다. (해제: ${new Date(userRow.penalty_until).toLocaleString()})`);
      const symbol = args[1]?.toUpperCase();
      const accNum = args[3];
      
      if (!symbol || !accNum) {
        return message.reply("❌ 사용법: `!매수 [코드] [수량/전부] [내계좌번호]`\n예: `!매수 SAMSUNG 10 1-1234-5678` (해당 계좌 잔액으로 매수)");
      }

      const stock = db.prepare("SELECT * FROM stocks WHERE symbol = ?").get(symbol);
      if (!stock) return message.reply("❌ 존재하지 않는 종목입니다.");

      const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
      if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");

      let quantity: number;
      if (args[2] === "전부") {
        quantity = Number(BigInt(account.balance) / BigInt(stock.price));
      } else {
        quantity = parseInt(args[2]);
      }

      if (isNaN(quantity) || quantity <= 0) return message.reply("❌ 올바른 수량을 입력해주세요.");

      const total = stock.price * quantity;
      if (BigInt(account.balance) < BigInt(total)) return message.reply(`❌ 계좌 잔액이 부족합니다. (필요: ${total.toLocaleString()}원)`);

      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(total, accNum);
      
      db.prepare(`
        INSERT INTO portfolio (userId, symbol, quantity, totalCost) 
        VALUES (?, ?, ?, ?) 
        ON CONFLICT(userId, symbol) 
        DO UPDATE SET 
          quantity = quantity + excluded.quantity,
          totalCost = totalCost + excluded.totalCost
      `).run(message.author.id, symbol, quantity, total);
      message.reply(`✅ **${stock.name}** ${quantity.toLocaleString()}주를 **${total.toLocaleString()}원**에 매수했습니다. (계좌: ${accNum})`);
    }

    if (command === "!매도") {
      if (isPenalized) return message.reply(`❌ 페널티 기간 중에는 주식 거래가 불가능합니다. (해제: ${new Date(userRow.penalty_until).toLocaleString()})`);
      const symbol = args[1]?.toUpperCase();
      const accNum = args[3];

      if (!symbol || !accNum) {
        return message.reply("❌ 사용법: `!매도 [코드] [수량/전부] [내계좌번호]`\n예: `!매도 SAMSUNG 전부 1-1234-5678` (매도 대금을 해당 계좌로 입금)");
      }

      const stock = db.prepare("SELECT * FROM stocks WHERE symbol = ?").get(symbol);
      if (!stock) return message.reply("❌ 존재하지 않는 종목입니다.");

      const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
      if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");

      let holdQuantity = 0;
      let holdTotalCost = 0;
      
      const hold = db.prepare("SELECT * FROM portfolio WHERE userId = ? AND symbol = ?").get(message.author.id, symbol);
      if (!hold || hold.quantity <= 0) return message.reply("❌ 보유 중인 주식이 없습니다.");
      holdQuantity = hold.quantity;
      holdTotalCost = hold.totalCost;

      let quantity: number;
      if (args[2] === "전부") {
        quantity = holdQuantity;
      } else {
        quantity = parseInt(args[2]);
      }

      if (isNaN(quantity) || quantity <= 0 || quantity > holdQuantity) return message.reply(`❌ 올바른 수량을 입력해주세요. (보유: ${holdQuantity.toLocaleString()}주)`);

      const total = Math.floor(stock.price * quantity);
      
      db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(total, accNum);
      
      const costPerShare = Math.floor(holdTotalCost / holdQuantity);
      const costOfSoldShares = costPerShare * quantity;
      db.prepare("UPDATE portfolio SET quantity = quantity - ?, totalCost = subBigInt(totalCost, ?) WHERE userId = ? AND symbol = ?").run(quantity, costOfSoldShares, message.author.id, symbol);
      message.reply(`✅ **${stock.name}** ${quantity.toLocaleString()}주를 **${total.toLocaleString()}원**에 매도했습니다. (계좌: ${accNum})`);
    }

    if (command === "!내주식") {
      const holds = db.prepare(`
        SELECT p.quantity, p.totalCost, s.name, s.symbol, s.price 
        FROM portfolio p 
        JOIN stocks s ON p.symbol = s.symbol 
        WHERE p.userId = ? AND p.quantity > 0
      `).all(message.author.id);

      if (holds.length === 0) return message.reply("📦 보유 중인 주식이 없습니다.");

      let reply = `📦 **${message.author.username}**님의 포트폴리오\n\`\`\`\n`;
      let totalValue = 0;
      let totalInvested = 0;

      holds.forEach((h: any) => {
        const currentValue = h.price * h.quantity;
        const profit = currentValue - h.totalCost;
        const profitPercent = h.totalCost > 0 ? ((profit / h.totalCost) * 100).toFixed(2) : "0.00";
        const sign = profit >= 0 ? "+" : "";
        
        totalValue += currentValue;
        totalInvested += h.totalCost;
        
        reply += `${h.name}(${h.symbol}): ${h.quantity}주\n`;
        reply += `  현재가: ${formatMoney(h.price)}원\n`;
        reply += `  평단가: ${Math.floor(h.totalCost / h.quantity).toLocaleString()}원\n`;
        reply += `  수익: ${sign}${profit.toLocaleString()}원 (${sign}${profitPercent}%)\n\n`;
      });
      
      const totalProfit = totalValue - totalInvested;
      const totalProfitPercent = totalInvested > 0 ? ((totalProfit / totalInvested) * 100).toFixed(2) : "0.00";
      const totalSign = totalProfit >= 0 ? "+" : "";

      reply += `\`\`\`\n💰 총 투자: **${totalInvested.toLocaleString()}원**\n`;
      reply += `📈 총 가치: **${totalValue.toLocaleString()}원**\n`;
      reply += `📊 총 수익: **${totalSign}${totalProfit.toLocaleString()}원 (${totalSign}${totalProfitPercent}%)**`;
      await sendChunkedMessage(message, reply);
    }

    if (command === "!이체") {
      const myAccNum = args[1];
      const targetAccNum = args[2];
      const amount = parseMoney(args[3]);
      
      if (!myAccNum || !targetAccNum || amount === null || amount <= 0n) {
        return message.reply("❌ 사용법: `!이체 [내계좌번호] [상대계좌번호] [금액]`\n예: `!이체 1-1234-5678 2-9876-5432 10000` (내 계좌에서 상대 계좌로 송금)");
      }

      const myAccount = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, myAccNum);
      if (!myAccount) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
      if (myAccount.balance < amount) return message.reply("❌ 계좌 잔액이 부족합니다.");

      const targetAccount = db.prepare("SELECT * FROM bank_accounts WHERE account_number = ?").get(targetAccNum);
      if (!targetAccount) return message.reply("❌ 존재하지 않는 상대 계좌번호입니다.");
      if (targetAccNum === myAccNum) return message.reply("❌ 동일한 계좌로는 이체할 수 없습니다.");

      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(amount, myAccNum);
      db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(amount, targetAccNum);
      
      message.reply(`✅ **${myAccNum}** 계좌에서 **${targetAccNum}** 계좌로 **${formatMoney(amount)}원**을 이체했습니다.`);
    }

    if (command === "!내계좌이체") {
      const fromBankId = parseInt(args[1]);
      const toBankId = parseInt(args[2]);
      const amount = parseMoney(args[3]);

      if (isNaN(fromBankId) || isNaN(toBankId) || amount === null || amount <= 0n) {
        return message.reply("❌ 사용법: `!내계좌이체 [출금은행번호] [입금은행번호] [금액]`\n예: `!내계좌이체 1 2 10000` (1번 은행 계좌에서 2번 은행 계좌로 송금)");
      }

      if (fromBankId === toBankId) {
        return message.reply("❌ 같은 은행의 계좌로는 이체할 수 없습니다.");
      }

      const fromAccount = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND bankId = ?").get(message.author.id, fromBankId);
      if (!fromAccount) return message.reply(`❌ ${fromBankId}번 은행에 개설된 계좌가 없습니다.`);
      if (fromAccount.balance < amount) return message.reply("❌ 출금 계좌의 잔액이 부족합니다.");

      const toAccount = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND bankId = ?").get(message.author.id, toBankId);
      if (!toAccount) return message.reply(`❌ ${toBankId}번 은행에 개설된 계좌가 없습니다.`);

      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(amount, fromAccount.account_number);
      db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(amount, toAccount.account_number);

      message.reply(`✅ **${fromBankId}번 은행** 계좌에서 **${toBankId}번 은행** 계좌로 **${formatMoney(amount)}원**을 이체했습니다.`);
    }

    // --- 채굴 명령어 ---
    if (command === "!채굴") {
      const sub = args[1];
      if (sub === "상점") {
        const devices = db.prepare("SELECT * FROM mining_devices").all();
        let reply = "🛒 **채굴 기기 상점**\n```\n";
        devices.forEach((d: any) => {
          reply += `[ID: ${d.id}] ${d.name}\n`;
          reply += `  가격: ${formatMoney(d.price)}원 | 성능: ${d.hash_rate.toFixed(6)} BTC/10m\n\n`;
        });
        reply += "```\n사용법: `!채굴 구매 [ID] [수량/전부] [계좌번호]`";
        await sendChunkedMessage(message, reply);
      } else if (sub === "구매") {
        const deviceId = parseInt(args[2]);
        let quantityStr = args[3];
        let accNum = args[4];
        
        // 하위 호환성: 수량을 입력하지 않고 계좌번호만 입력한 경우
        if (!accNum) {
          accNum = args[3];
          quantityStr = "1";
        }
        
        if (isNaN(deviceId) || !accNum) return message.reply("❌ 사용법: `!채굴 구매 [ID] [수량/전부] [내계좌번호]`");

        const device = db.prepare("SELECT * FROM mining_devices WHERE id = ?").get(deviceId);
        if (!device) return message.reply("❌ 존재하지 않는 기기입니다.");

        const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
        if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");

        const myMinerCount = db.prepare("SELECT COUNT(*) as count FROM user_miners WHERE userId = ?").get(message.author.id).count;
        const userRow = db.prepare("SELECT miner_slots FROM users WHERE id = ?").get(message.author.id);
        const maxSlots = userRow?.miner_slots || 10;
        const availableSlots = maxSlots - myMinerCount;
        
        if (availableSlots <= 0) return message.reply(`❌ 채굴 기기는 최대 ${maxSlots}개까지만 소유할 수 있습니다. \`!채굴 슬롯확장\`으로 공간을 늘리세요.`);

        let quantity = 1;
        if (quantityStr === "전부") {
          quantity = Number(BigInt(account.balance) / BigInt(device.price));
          if (quantity > availableSlots) quantity = availableSlots;
        } else {
          quantity = parseInt(quantityStr);
          if (isNaN(quantity) || quantity <= 0) return message.reply("❌ 올바른 수량을 입력해주세요.");
        }

        if (quantity === 0) return message.reply(`❌ 계좌 잔액이 부족하거나 구매할 수 있는 수량이 없습니다.`);
        if (quantity > availableSlots) return message.reply(`❌ 슬롯이 부족합니다. (구매 가능: ${availableSlots}개)`);

        const totalCost = BigInt(device.price) * BigInt(quantity);
        if (BigInt(account.balance) < BigInt(totalCost)) return message.reply(`❌ 계좌 잔액이 부족합니다. (필요: ${formatMoney(totalCost)}원)`);

        db.prepare("INSERT OR IGNORE INTO users (id, btc_balance) VALUES (?, 0)").run(message.author.id);
        db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(totalCost, accNum);
        
        const insertMiner = db.prepare("INSERT INTO user_miners (userId, deviceId) VALUES (?, ?)");
        const insertMany = db.transaction((count: number) => {
          for (let i = 0; i < count; i++) insertMiner.run(message.author.id, deviceId);
        });
        insertMany(quantity);

        message.reply(`✅ **${device.name}** ${quantity}개 구매 완료! 총 **${formatMoney(totalCost)}원** 지불. (계좌: ${accNum})`);
      } else if (sub === "슬롯확장") {
        const accNum = args[2];
        const quantityStr = args[3] || "1";
        if (!accNum) return message.reply("❌ 사용법: `!채굴 슬롯확장 [내계좌번호] [횟수(선택)]`\n비용: 1억 원당 +5칸 (최대 3000칸)");
        
        let quantity = parseInt(quantityStr);
        if (isNaN(quantity) || quantity <= 0) return message.reply("❌ 올바른 횟수를 입력해주세요.");

        const userRow = db.prepare("SELECT miner_slots FROM users WHERE id = ?").get(message.author.id);
        const currentSlots = userRow?.miner_slots || 10;
        
        if (currentSlots >= 3000) return message.reply("❌ 이미 최대 슬롯(3000칸)에 도달했습니다.");
        
        const maxPossibleExpansions = Math.ceil((3000 - currentSlots) / 5);
        if (quantity > maxPossibleExpansions) quantity = maxPossibleExpansions;
        
        const costPerExpansion = 100000000n;
        const totalCost = BigInt(costPerExpansion) * BigInt(quantity);
        const addedSlots = quantity * 5;
        
        const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
        if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
        if (BigInt(account.balance) < BigInt(totalCost)) return message.reply(`❌ 계좌 잔액이 부족합니다. (필요 금액: ${formatMoney(totalCost)}원)`);

        db.prepare("INSERT OR IGNORE INTO users (id) VALUES (?)").run(message.author.id);
        db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(totalCost, accNum);
        db.prepare("UPDATE users SET miner_slots = COALESCE(miner_slots, 10) + ? WHERE id = ?").run(addedSlots, message.author.id);
        
        const newSlots = db.prepare("SELECT miner_slots FROM users WHERE id = ?").get(message.author.id).miner_slots;
        message.reply(`✅ **${formatMoney(totalCost)}원**을 지불하여 채굴기 슬롯을 **${addedSlots}칸** 확장했습니다! (총 슬롯: ${newSlots}칸)`);
      } else if (sub === "판매") {
        const minerId = parseInt(args[2]);
        const accNum = args[3];
        if (isNaN(minerId) || !accNum) return message.reply("❌ 사용법: `!채굴 판매 [소유ID] [입금받을계좌번호]`\n💡 소유 ID는 `!채굴 현황`에서 확인 가능합니다.");

        const miner = db.prepare(`
          SELECT um.*, d.name, d.price 
          FROM user_miners um 
          JOIN mining_devices d ON um.deviceId = d.id 
          WHERE um.id = ? AND um.userId = ?
        `).get(minerId, message.author.id);
        
        if (!miner) return message.reply("❌ 본인 소유의 기기가 아니거나 존재하지 않습니다.");

        const account = db.prepare("SELECT 1 FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
        if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");

        const refund = Math.floor(miner.price * 0.5);
        db.prepare("DELETE FROM user_miners WHERE id = ?").run(minerId);
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(refund, accNum);
        message.reply(`✅ **${miner.name}**을 판매하여 **${refund.toLocaleString()}원**을 환급받았습니다. (계좌: ${accNum})`);
      } else if (sub === "현황") {
        const miners = db.prepare(`
          SELECT um.id, d.name, d.hash_rate 
          FROM user_miners um 
          JOIN mining_devices d ON um.deviceId = d.id 
          WHERE um.userId = ?
        `).all(message.author.id);
        
        const user = db.prepare("SELECT btc_balance FROM users WHERE id = ?").get(message.author.id);
        const btc = user?.btc_balance || 0;

        if (miners.length === 0) return message.reply(`⛏️ **${message.author.username}**님은 현재 채굴 중이 아닙니다.\n보유 BTC: **${btc.toFixed(6)} BTC**`);

        let totalHash = 0;
        let reply = `⛏️ **${message.author.username}**님의 채굴 현황\n보유 BTC: **${btc.toFixed(6)} BTC**\n\`\`\`\n`;
        miners.forEach((m: any) => {
          reply += `[소유ID: ${m.id}] ${m.name} (${m.hash_rate.toFixed(6)} BTC/10m)\n`;
          totalHash += m.hash_rate;
        });
        reply += `\`\`\`\n총 해시레이트: **${totalHash.toFixed(6)} BTC/10m**\n(10분마다 자동 채굴됩니다.)`;
        await sendChunkedMessage(message, reply);
      } else if (sub === "정산") {
        let quantityStr = args[2];
        const accNum = args[3];

        if (!quantityStr || !accNum) return message.reply("❌ 사용법: `!채굴 정산 [소수점수량/전부] [입금받을계좌번호]`");

        const userRow = db.prepare("SELECT btc_balance FROM users WHERE id = ?").get(message.author.id);
        const holdQuantity = userRow ? userRow.btc_balance : 0;
        if (holdQuantity <= 0) return message.reply("❌ 보유 중인 채굴 BTC가 없습니다.");

        let quantity: number;
        if (quantityStr === "전부") {
          quantity = holdQuantity;
        } else {
          quantity = parseFloat(quantityStr);
        }

        if (isNaN(quantity) || quantity <= 0 || quantity > holdQuantity) {
          return message.reply(`❌ 올바른 수량을 입력해주세요. (보유: ${holdQuantity.toFixed(6)} BTC)`);
        }

        const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
        if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");

        const EXCHANGE_RATE = 100000000; // 1 BTC = 1억 원 고정
        const totalKRW = Math.floor(quantity * EXCHANGE_RATE);

        db.prepare("UPDATE users SET btc_balance = btc_balance - ? WHERE id = ?").run(quantity, message.author.id);
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(totalKRW, accNum);

        message.reply(`✅ 채굴한 **${quantity.toFixed(6)} BTC**를 정산하여 **${totalKRW.toLocaleString()}원**을 계좌(${accNum})로 입금받았습니다!`);
      } else {
        return message.reply("❌ 사용법: `!채굴 [상점/구매/판매/현황/슬롯확장/정산]`");
      }
    }

    if (command === "!은행") {
      const sub = args[1];
      if (sub === "가입") {
        const bankId = parseInt(args[2]);
        if (![1, 2, 3].includes(bankId)) return message.reply("❌ 사용법: `!은행 가입 [1/2/3]`");

        const exists = db.prepare("SELECT 1 FROM bank_accounts WHERE userId = ? AND bankId = ?").get(message.author.id, bankId);
        if (exists) return message.reply(`❌ 이미 ${bankId}번 은행에 계좌가 있습니다.`);

        const accNum = `${bankId}-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`;
        db.prepare("INSERT INTO bank_accounts (userId, bankId, account_number) VALUES (?, ?, ?)").run(message.author.id, bankId, accNum);
        message.reply(`🏦 **${bankId}번 은행** 계좌 개설 완료! (계좌번호: **${accNum}**)`);
      } else if (sub === "목록") {
        const allAccounts = db.prepare(`
          SELECT b.*
          FROM bank_accounts b
        `).all();
        
        let reply = "📋 **전체 계좌 목록**\n```\n";
        for (const acc of allAccounts) {
          const user = client.users.cache.get(acc.userId);
          const ownerName = user ? user.username : `ID:${acc.userId.slice(0, 5)}...`;
          reply += `은행 ${acc.bankId} | ${acc.account_number} | 소유주: ${ownerName}\n`;
        }
        reply += "```\n이체 시 위 계좌번호를 사용하세요.";
        
        await sendChunkedMessage(message, reply);
      } else {
        const accounts = db.prepare("SELECT * FROM bank_accounts WHERE userId = ?").all(message.author.id);
        let reply = "🏦 **은행별 금리 정보 (30분마다 정산)**\n";
        reply += "1번 은행: 예금 3.0% | 대출 10.0%\n";
        reply += "2번 은행: 예금 2.0% | 대출 7.0%\n";
        reply += "3번 은행: 예금 1.0% | 대출 5.0%\n\n";
        reply += "💳 **내 계좌 현황**\n```\n";
        [1, 2, 3].forEach(id => {
          const acc = accounts.find((a: any) => a.bankId === id);
          reply += `${id}번 은행: ${acc ? acc.account_number + " (" + acc.balance.toLocaleString() + "원)" : "계좌 없음"}\n`;
        });
        reply += "```\n사용법: `!은행 가입 [번호]`, `!은행 목록`";
        await sendChunkedMessage(message, reply);
      }
    }

    // --- 대출 명령어 ---
    if (command === "!대출") {
      const sub = args[1];
      if (sub === "신청") {
        const bankId = parseInt(args[2]);
        const amount = parseMoney(args[3]);
        const days = parseInt(args[4]);
        const accNum = args[5];

        if (![1, 2, 3].includes(bankId) || amount === null || amount <= 0n || isNaN(days) || days < 1 || days > 14 || !accNum) {
          return message.reply("❌ 사용법: `!대출 신청 [은행번호] [금액] [기간(1~14일)] [입금받을계좌번호]`\n예: `!대출 신청 1 500000 7 2-1234-5678` (1번 은행에서 빌려 2번 은행 계좌로 입금)");
        }

        if (amount > 1500000000) {
          return message.reply("❌ 한 번에 최대 15억 원까지만 대출할 수 있습니다.");
        }

        const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
        if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");

        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + days);

        db.prepare("INSERT INTO loans (userId, bankId, principal, current_amount, due_date) VALUES (?, ?, ?, ?, ?)")
          .run(message.author.id, bankId, amount, amount, dueDate.toISOString());
        
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);
        
        message.reply(`📝 **${bankId}번 은행**에서 **${formatMoney(amount)}원** 대출 완료! (계좌 **${accNum}**으로 입금됨, 만기: ${dueDate.toLocaleDateString()})`);
      } else if (sub === "일괄상환" || sub === "전체상환") {
        const accNum = args[2];
        if (!accNum) return message.reply("❌ 사용법: `!대출 일괄상환 [출금할계좌번호]`\n예: `!대출 일괄상환 1-1234`");

        const loans = db.prepare("SELECT * FROM loans WHERE userId = ?").all(message.author.id);
        if (loans.length === 0) return message.reply("❌ 현재 대출 내역이 없습니다.");

        let totalDebt = 0n;
        for (const loan of loans) {
          totalDebt += BigInt(loan.current_amount);
        }

        const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
        if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");

        if (BigInt(account.balance) < totalDebt) {
          return message.reply(`❌ 계좌 잔액이 부족합니다.\n총 대출금: **${formatMoney(totalDebt)}원**\n현재 잔액: **${formatMoney(account.balance)}원**`);
        }

        db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(totalDebt, accNum);
        db.prepare("DELETE FROM loans WHERE userId = ?").run(message.author.id);

        message.reply(`✅ 총 **${loans.length}건**의 대출금 **${formatMoney(totalDebt)}원**을 일괄 상환 완료했습니다. (출금 계좌: ${accNum})`);
      } else if (sub === "상환") {
        const loanIdStr = args[2];
        let amountStr = args[3];
        let accNum = args[4];

        if (loanIdStr === "전체" || loanIdStr === "일괄" || loanIdStr === "전부") {
          const targetAccNum = args[3];
          if (!targetAccNum) return message.reply("❌ 사용법: `!대출 상환 전체 [출금할계좌번호]`\n예: `!대출 상환 전체 1-1234`");

          const loans = db.prepare("SELECT * FROM loans WHERE userId = ?").all(message.author.id);
          if (loans.length === 0) return message.reply("❌ 현재 대출 내역이 없습니다.");

          let totalDebt = 0n;
          for (const loan of loans) {
            totalDebt += BigInt(loan.current_amount);
          }

          const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, targetAccNum);
          if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");

          if (BigInt(account.balance) < totalDebt) {
            return message.reply(`❌ 계좌 잔액이 부족합니다.\n총 대출금: **${formatMoney(totalDebt)}원**\n현재 잔액: **${formatMoney(account.balance)}원**`);
          }

          db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(totalDebt, targetAccNum);
          db.prepare("DELETE FROM loans WHERE userId = ?").run(message.author.id);

          return message.reply(`✅ 총 **${loans.length}건**의 대출금 **${formatMoney(totalDebt)}원**을 일괄 상환 완료했습니다. (출금 계좌: ${targetAccNum})`);
        }

        const loanId = parseInt(loanIdStr);

        if (!accNum && amountStr && amountStr.includes("-")) {
          accNum = amountStr;
          amountStr = "전액";
        }

        if (isNaN(loanId) || !accNum) return message.reply("❌ 사용법: `!대출 상환 [대출ID] [상환할금액(또는 '전액')] [출금할계좌번호]`\n예: `!대출 상환 1 50000 1-1234` 또는 `!대출 상환 1 전액 1-1234`\n💡 전체 대출을 갚으려면: `!대출 일괄상환 [계좌번호]`");

        const loan = db.prepare("SELECT * FROM loans WHERE id = ? AND userId = ?").get(loanId, message.author.id);
        if (!loan) return message.reply("❌ 해당 대출 정보를 찾을 수 없습니다.");

        let repayAmount = loan.current_amount;
        if (amountStr !== "전액") {
          repayAmount = parseMoney(amountStr);
          if (isNaN(repayAmount) || repayAmount <= 0) return message.reply("❌ 올바른 상환 금액을 입력해주세요.");
          if (repayAmount > loan.current_amount) repayAmount = loan.current_amount;
        }

        const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
        if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");

        if (account.balance < repayAmount) return message.reply(`❌ 계좌 잔액이 부족합니다. (필요: ${repayAmount.toLocaleString()}원)`);

        db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(repayAmount, accNum);
        
        if (repayAmount >= loan.current_amount) {
          db.prepare("DELETE FROM loans WHERE id = ?").run(loanId);
          message.reply(`✅ 대출금 **${repayAmount.toLocaleString()}원**을 전액 상환 완료했습니다. (계좌: ${accNum})`);
        } else {
          db.prepare("UPDATE loans SET current_amount = subBigInt(current_amount, ?) WHERE id = ?").run(repayAmount, loanId);
          const remain = loan.current_amount - repayAmount;
          message.reply(`✅ 대출금 **${repayAmount.toLocaleString()}원**을 부분 상환했습니다.\n남은 대출금: **${remain.toLocaleString()}원** (계좌: ${accNum})`);
        }
      } else {
        const loans = db.prepare("SELECT * FROM loans WHERE userId = ?").all(message.author.id);
        if (loans.length === 0) return message.reply("📄 현재 대출 내역이 없습니다.");

        let reply = "📄 **내 대출 내역**\n```\n";
        loans.forEach((l: any) => {
          reply += `[ID: ${l.id}] ${l.bankId}번 은행: ${formatMoney(l.current_amount)}원 (만기: ${new Date(l.due_date).toLocaleDateString()})\n`;
        });
        reply += "```\n사용법: `!대출 상환 [대출ID] [상환할금액] [출금할계좌번호]`\n💡 전체 대출을 한 번에 갚으려면: `!대출 일괄상환 [계좌번호]`";
        await sendChunkedMessage(message, reply);
      }
    }

    // --- 도박 명령어 ---
    if (command === "!도박") {
      if (args.length < 3) {
        return message.reply("🪙 **기본 도박 설명**\n가장 단순한 50% 확률의 동전 던지기식 도박입니다.\n- **승리 시**: 베팅금의 **2배**를 얻습니다.\n- **패배 시**: 베팅금을 모두 잃습니다.\n👉 **사용법**: `!도박 [금액] [내계좌번호]`\n예시: `!도박 50000 1-1234-5678`");
      }
      const amount = parseMoney(args[1]);
      const accNum = args[2];
      if (amount === null || amount <= 0n || !accNum) return message.reply("❌ 사용법: `!도박 [금액] [내계좌번호]`");

      const userId = message.author.id;
      const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(userId, accNum);
      if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
      if (BigInt(account.balance) < amount) return message.reply("❌ 계좌 잔액이 부족합니다.");

      const win = Math.random() > 0.5;
      if (win) {
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);
        message.reply(`🎊 **당첨!** **${formatMoney(amount)}원**을 얻었습니다! (계좌: ${accNum})`);
      } else {
        db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);
        message.reply(`💸 **꽝...** **${formatMoney(amount)}원**을 잃었습니다. (계좌: ${accNum})`);
      }
    }

    // --- 블랙잭 명령어 ---
    if (command === "!블랙잭") {
      if (args.length < 3) {
        return message.reply("🃏 **블랙잭(Blackjack) 게임 설명**\n딜러(봇)와 카드를 겨루어 카드의 합이 **21**에 더 가까운 쪽이 승리하는 클래식 카드 게임입니다.\n\n**[카드 점수]**\n- 숫자 카드(2~10): 적힌 숫자 그대로 계산\n- 알파벳 카드(J, Q, K): **10**으로 계산\n- 에이스(A): 상황에 따라 **1** 또는 **11**로 유리하게 자동 계산\n\n**[진행 방법]**\n- **히트(Hit)**: 카드를 1장 더 받습니다. 단, 합이 21을 초과하면 즉시 패배(버스트)합니다.\n- **스탠드(Stand)**: 카드를 그만 받고 딜러와 최종 점수를 겨룹니다. (딜러는 17 이상이 될 때까지 무조건 카드를 뽑습니다.)\n\n**[배당]** 승리 시 **2배**, 무승부 시 **환불**\n👉 **사용법**: `!블랙잭 [베팅금액] [내계좌번호]`");
      }
      const amount = parseMoney(args[1]);
      const accNum = args[2];
      if (amount === null || amount <= 0n || !accNum) return message.reply("❌ 사용법: `!블랙잭 [베팅금액] [내계좌번호]`");

      if (activeBlackjacks.has(message.author.id)) {
        return message.reply("❌ 이미 진행 중인 블랙잭 게임이 있습니다.");
      }

      const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
      if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
      if (BigInt(account.balance) < amount) return message.reply("❌ 계좌 잔액이 부족합니다.");

      // 베팅금 차감
      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);

      const deck = getDeck();
      const playerHand = [deck.pop(), deck.pop()];
      const dealerHand = [deck.pop(), deck.pop()];

      const gameState = {
        userId: message.author.id,
        accNum,
        amount,
        deck,
        playerHand,
        dealerHand,
      };
      activeBlackjacks.set(message.author.id, gameState);

      const playerScore = calculateScore(playerHand);
      const dealerVisibleScore = calculateScore([dealerHand[0]]);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('bj_hit').setLabel('히트 (카드 받기)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('bj_stand').setLabel('스탠드 (멈춤)').setStyle(ButtonStyle.Danger)
      );

      message.reply({
        content: `🃏 **블랙잭 시작!** (베팅: ${formatMoney(amount)}원)\n\n👤 **플레이어 (${playerScore})**: ${playerHand.map((c:any) => c.suit + c.value).join(', ')}\n🤖 **딜러 (${dealerVisibleScore})**: ${dealerHand[0].suit + dealerHand[0].value}, ❓\n\n카드를 더 받으시겠습니까?`,
        components: [row]
      });
    }

    // --- 슬롯머신 명령어 ---
    if (command === "!슬롯머신") {
      if (args.length < 3) {
        return message.reply("🎰 **슬롯머신 게임 설명**\n3개의 과일/보석 심볼을 돌려 일치하는 개수와 종류에 따라 상금을 받는 게임입니다!\n\n**[배당률]**\n- 7️⃣ 7️⃣ 7️⃣ : **50배** (잭팟!)\n- 💎 💎 💎 : **10배**\n- 🍒 🍒 🍒 : **3배**\n- 기타 과일 3개 일치 : **5배**\n- 아무 심볼이나 2개 일치 : **1.5배**\n- 일치하는 심볼 없음 : 꽝 (베팅금 증발)\n\n👉 **사용법**: `!슬롯머신 [베팅금액] [내계좌번호]`");
      }
      const amount = parseMoney(args[1]);
      const accNum = args[2];
      if (amount === null || amount <= 0n || !accNum) return message.reply("❌ 사용법: `!슬롯머신 [금액] [내계좌번호]`");

      const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
      if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
      if (BigInt(account.balance) < amount) return message.reply("❌ 계좌 잔액이 부족합니다.");

      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);

      const getRandomSymbol = () => {
        const r = Math.random();
        if (r < 0.05) return "7️⃣";
        if (r < 0.15) return "💎";
        if (r < 0.35) return "🍉";
        if (r < 0.55) return "🍇";
        if (r < 0.75) return "🍋";
        return "🍒";
      };

      const s1 = getRandomSymbol();
      const s2 = getRandomSymbol();
      const s3 = getRandomSymbol();

      let multiplier = 0;
      let resultText = "꽝... 베팅금을 잃었습니다.";

      if (s1 === s2 && s2 === s3) {
        if (s1 === "7️⃣") multiplier = 50;
        else if (s1 === "💎") multiplier = 10;
        else if (s1 === "🍒") multiplier = 3;
        else multiplier = 5;
        resultText = `🎉 **잭팟!** ${multiplier}배 당첨!`;
      } else if (s1 === s2 || s2 === s3 || s1 === s3) {
        multiplier = 1.5;
        resultText = `✨ **아쉽게 2개 일치!** 1.5배 당첨!`;
      }

      const winAmount = (amount * BigInt(Math.floor(multiplier * 100))) / 100n;
      if (winAmount > 0) {
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, accNum);
      }

      message.reply(`🎰 **슬롯머신 결과** 🎰\n[ ${s1} | ${s2} | ${s3} ]\n${resultText}\n(결과: ${winAmount > 0 ? '+' : '-'}${winAmount > 0 ? winAmount.toLocaleString() : formatMoney(amount)}원)`);
    }

    // --- 홀짝 명령어 ---
    if (command === "!홀짝") {
      if (args.length < 4) {
        return message.reply("🎲 **홀짝 게임 설명**\n1부터 6까지 있는 주사위를 하나 굴려, 나온 숫자가 홀수인지 짝수인지 맞히는 직관적인 게임입니다.\n- **홀수**: 1, 3, 5\n- **짝수**: 2, 4, 6\n- 맞히면 베팅금의 **2배**를 얻고, 틀리면 모두 잃습니다.\n\n👉 **사용법**: `!홀짝 [베팅금액] [내계좌번호] [홀/짝]`\n예시: `!홀짝 10000 1-1234-5678 짝`");
      }
      const amount = parseMoney(args[1]);
      const accNum = args[2];
      const choice = args[3];

      if (amount === null || amount <= 0n || !accNum || !["홀", "짝"].includes(choice)) {
        return message.reply("❌ 사용법: `!홀짝 [금액] [내계좌번호] [홀/짝]`");
      }

      const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
      if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
      if (BigInt(account.balance) < amount) return message.reply("❌ 계좌 잔액이 부족합니다.");

      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);

      const dice = Math.floor(Math.random() * 6) + 1;
      const isEven = dice % 2 === 0;
      const resultStr = isEven ? "짝" : "홀";

      if (choice === resultStr) {
        const winAmount = amount * 2n;
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, accNum);
        message.reply(`🎲 주사위 결과: **${dice} (${resultStr})**\n🎉 **정답입니다!** **${winAmount.toLocaleString()}원**을 얻었습니다! (계좌: ${accNum})`);
      } else {
        message.reply(`🎲 주사위 결과: **${dice} (${resultStr})**\n💸 **틀렸습니다...** **${formatMoney(amount)}원**을 잃었습니다. (계좌: ${accNum})`);
      }
    }

    // --- 경마 명령어 ---
    if (command === "!경마") {
      if (args.length < 4) {
        return message.reply("🐎 **경마 게임 설명**\n1번부터 4번까지 총 4마리의 말 중, 경주에서 우승할 1마리의 말을 예측하여 맞히는 게임입니다.\n- 4분의 1 확률을 뚫고 우승마를 맞히면 베팅금의 **4배**를 상금으로 받습니다!\n- 틀리면 베팅금을 모두 잃습니다.\n\n👉 **사용법**: `!경마 [베팅금액] [내계좌번호] [말번호(1~4)]`\n예시: `!경마 50000 1-1234-5678 3` (3번 말에 5만원 베팅)");
      }
      const amount = parseMoney(args[1]);
      const accNum = args[2];
      const horse = parseInt(args[3]);

      if (amount === null || amount <= 0n || !accNum || isNaN(horse) || horse < 1 || horse > 4) {
        return message.reply("❌ 사용법: `!경마 [금액] [내계좌번호] [말번호(1~4)]`");
      }

      const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
      if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
      if (BigInt(account.balance) < amount) return message.reply("❌ 계좌 잔액이 부족합니다.");

      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);

      const winningHorse = Math.floor(Math.random() * 4) + 1;
      
      let resultMsg = `🏁 **경마 결과** 🏁\n우승마: 🐎 **${winningHorse}번 말**\n\n`;
      if (horse === winningHorse) {
        const winAmount = amount * 4n;
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, accNum);
        resultMsg += `🎉 **적중!** **${winAmount.toLocaleString()}원**을 얻었습니다! (계좌: ${accNum})`;
      } else {
        resultMsg += `💸 **낙첨...** 베팅금을 잃었습니다. (선택: ${horse}번 말)`;
      }
      message.reply(resultMsg);
    }

    // --- 가위바위보 명령어 ---
    if (command === "!가위바위보") {
      if (args.length < 4) {
        return message.reply("✌️✊🖐️ **가위바위보 게임 설명**\n봇 또는 서버의 다른 유저와 가위바위보 대결을 펼칩니다.\n- **승리**: 베팅금의 **2배** 획득\n- **무승부**: 베팅금 **전액 환불**\n- **패배**: 베팅금 전액 상실\n\n**[모드별 사용법]**\n👉 **봇과 대결 (PvE)**: `!가위바위보 [베팅금액] [내계좌번호] [가위/바위/보]`\n👉 **유저와 대결 (PvP)**: `!가위바위보 [베팅금액] [내계좌번호] [@상대방멘션]`\n*(PvP 모드에서는 상대방이 \`!수락\`을 누르면 비밀 버튼을 통해 서로의 패를 비공개로 선택합니다!)*");
      }
      const amount = parseMoney(args[1]);
      const accNum = args[2];
      const targetOrChoice = args[3];

      if (amount === null || amount <= 0n || !accNum) {
        return message.reply("❌ 사용법: `!가위바위보 [금액] [내계좌번호] [가위/바위/보 또는 @상대방]`");
      }

      const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
      if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
      if (BigInt(account.balance) < amount) return message.reply("❌ 계좌 잔액이 부족합니다.");

      // PvP 모드
      if (targetOrChoice.startsWith("<@") && targetOrChoice.endsWith(">")) {
        const targetId = targetOrChoice.replace(/[<@!>]/g, "");
        if (targetId === message.author.id) return message.reply("❌ 자기 자신과는 대결할 수 없습니다.");
        
        const duelId = `rps_${Date.now()}`;
        activeDuels.set(duelId, {
          type: 'rps',
          p1: message.author.id,
          p2: targetId,
          p1Acc: accNum,
          p2Acc: null, // 수락 시 채워짐
          amount: amount,
          p1Choice: null,
          p2Choice: null,
          channelId: message.channel.id,
          messageId: null
        });

        return message.reply(`⚔️ <@${message.author.id}>님이 <@${targetId}>님에게 **가위바위보 대결**을 신청했습니다! (판돈: ${formatMoney(amount)}원)\n<@${targetId}>님은 \`!수락 ${duelId} [내계좌번호]\` 명령어로 대결을 받아주세요!`);
      }

      // PvE 모드 (봇과 대결)
      const validChoices = ["가위", "바위", "보"];
      if (!validChoices.includes(targetOrChoice)) return message.reply("❌ 올바른 선택지(가위/바위/보) 또는 상대방을 멘션해주세요.");

      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);

      const botChoice = validChoices[Math.floor(Math.random() * 3)];
      
      let result = "";
      let winAmount = 0n;
      
      if (targetOrChoice === botChoice) {
        result = "무승부";
        winAmount = amount;
      } else if (
        (targetOrChoice === "가위" && botChoice === "보") ||
        (targetOrChoice === "바위" && botChoice === "가위") ||
        (targetOrChoice === "보" && botChoice === "바위")
      ) {
        result = "승리";
        winAmount = amount * 2n;
      } else {
        result = "패배";
      }

      if (winAmount > 0) {
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, accNum);
      }

      let msg = `🤖 봇: **${botChoice}** vs 👤 플레이어: **${targetOrChoice}**\n`;
      if (result === "승리") msg += `🎉 **승리!** **${winAmount.toLocaleString()}원** 획득!`;
      else if (result === "무승부") msg += `🤝 **무승부!** 베팅금을 돌려받았습니다.`;
      else msg += `💸 **패배...** 베팅금을 잃었습니다.`;
      
      message.reply(msg);
    }

    // --- 룰렛 명령어 ---
    if (command === "!룰렛") {
      if (args.length < 4) {
        return message.reply("🎡 **룰렛 게임 설명**\n회전하는 룰렛 판의 구슬이 빨강, 검정, 초록 중 어느 색상에 멈출지 예측하는 게임입니다.\n\n**[색상별 확률 및 배당]**\n- 🔴 **빨강** (약 46.6% 확률): 적중 시 **2배**\n- ⚫ **검정** (약 46.6% 확률): 적중 시 **2배**\n- 🟢 **초록** (약 6.6% 확률): 적중 시 무려 **14배** (잭팟!)\n\n👉 **사용법**: `!룰렛 [베팅금액] [내계좌번호] [빨강/검정/초록]`\n예시: `!룰렛 10000 1-1234-5678 초록`");
      }
      const amount = parseMoney(args[1]);
      const accNum = args[2];
      const choice = args[3];

      if (amount === null || amount <= 0n || !accNum || !["빨강", "검정", "초록"].includes(choice)) {
        return message.reply("❌ 사용법: `!룰렛 [금액] [내계좌번호] [빨강/검정/초록]`");
      }

      const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
      if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
      if (BigInt(account.balance) < amount) return message.reply("❌ 계좌 잔액이 부족합니다.");

      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);

      // 0~14. 0: 초록, 1~7: 빨강, 8~14: 검정
      const roll = Math.floor(Math.random() * 15);
      let resultColor = "";
      let multiplier = 0;

      if (roll === 0) {
        resultColor = "초록";
        multiplier = 14;
      } else if (roll >= 1 && roll <= 7) {
        resultColor = "빨강";
        multiplier = 2;
      } else {
        resultColor = "검정";
        multiplier = 2;
      }

      const winAmount = amount * BigInt(multiplier);
      let msg = `🎡 룰렛이 돌아갑니다... 멈춘 색상은 **${resultColor}**!\n`;

      if (choice === resultColor) {
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, accNum);
        msg += `🎉 **적중!** **${winAmount.toLocaleString()}원** 획득! (${multiplier}배)`;
      } else {
        msg += `💸 **낙첨...** 베팅금을 잃었습니다.`;
      }

      message.reply(msg);
    }

    // --- 크래시 명령어 ---
    if (command === "!크래시") {
      if (args.length < 4) {
        return message.reply("🚀 **크래시(Crash) 게임 설명**\n로켓이 발사되어 배수가 1.0x부터 점점 상승하다가, 무작위 시점에 갑자기 '크래시(폭발)'합니다.\n플레이어는 로켓이 폭발하기 전에 도달할 **목표 배수**를 미리 설정해야 합니다.\n\n- **성공**: 실제 폭발 지점이 목표 배수보다 높거나 같으면, **베팅금 × 목표 배수**만큼 상금을 얻습니다!\n- **실패**: 로켓이 목표 배수에 도달하기 전에 폭발해버리면 베팅금을 모두 잃습니다.\n*(안전하게 1.5배를 노릴지, 위험을 감수하고 10배를 노릴지 선택하세요!)*\n\n👉 **사용법**: `!크래시 [베팅금액] [내계좌번호] [목표배수(1.1 이상)]`\n예시: `!크래시 10000 1-1234-5678 2.5`");
      }
      const amount = parseMoney(args[1]);
      const accNum = args[2];
      const target = parseFloat(args[3]);

      if (amount === null || amount <= 0n || !accNum || isNaN(target) || target < 1.1) {
        return message.reply("❌ 사용법: `!크래시 [금액] [내계좌번호] [목표배수(1.1 이상)]`");
      }

      const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
      if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
      if (BigInt(account.balance) < amount) return message.reply("❌ 계좌 잔액이 부족합니다.");

      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);

      const rand = Math.random();
      let crashPoint = 0.99 / rand;
      if (crashPoint < 1.0) crashPoint = 1.0;
      if (crashPoint > 100.0) crashPoint = 100.0;
      crashPoint = parseFloat(crashPoint.toFixed(2));

      let msg = `🚀 **크래시 게임 결과**\n목표 배수: **${target}x**\n실제 추락 지점: **${crashPoint}x**\n\n`;

      if (crashPoint >= target) {
        const winAmount = (amount * BigInt(Math.floor(target * 100))) / 100n;
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, accNum);
        msg += `🎉 **성공!** 그래프가 목표에 도달했습니다! **${winAmount.toLocaleString()}원** 획득!`;
      } else {
        msg += `💥 **크래시!** 목표 도달 전에 추락했습니다... 베팅금을 잃었습니다.`;
      }
      message.reply(msg);
    }

    // --- 주사위배틀 명령어 ---
    if (command === "!주사위배틀") {
      if (args.length < 3) {
        return message.reply("🎲 **주사위배틀 게임 설명**\n봇 또는 다른 유저와 각각 **2개의 주사위**를 굴려, 나온 눈의 합이 더 큰 쪽이 승리하는 게임입니다.\n- **승리**: 베팅금의 **2배** 획득 (PvP의 경우 승자가 판돈 독식)\n- **무승부**: 베팅금 **전액 환불**\n- **패배**: 베팅금 전액 상실\n\n**[모드별 사용법]**\n👉 **봇과 대결 (PvE)**: `!주사위배틀 [베팅금액] [내계좌번호]`\n👉 **유저와 대결 (PvP)**: `!주사위배틀 [베팅금액] [내계좌번호] [@상대방멘션]`\n*(PvP 모드에서는 상대방이 \`!수락\` 명령어를 입력해야 대결이 시작됩니다!)*");
      }
      const amount = parseMoney(args[1]);
      const accNum = args[2];
      const targetMention = args[3];

      if (amount === null || amount <= 0n || !accNum) {
        return message.reply("❌ 사용법: `!주사위배틀 [금액] [내계좌번호] [@상대방(선택)]`");
      }

      const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
      if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
      if (BigInt(account.balance) < amount) return message.reply("❌ 계좌 잔액이 부족합니다.");

      // PvP 모드
      if (targetMention && targetMention.startsWith("<@") && targetMention.endsWith(">")) {
        const targetId = targetMention.replace(/[<@!>]/g, "");
        if (targetId === message.author.id) return message.reply("❌ 자기 자신과는 대결할 수 없습니다.");
        
        const duelId = `dice_${Date.now()}`;
        activeDuels.set(duelId, {
          type: 'dice',
          p1: message.author.id,
          p2: targetId,
          p1Acc: accNum,
          p2Acc: null,
          amount: amount,
          channelId: message.channel.id
        });

        return message.reply(`⚔️ <@${message.author.id}>님이 <@${targetId}>님에게 **주사위 배틀**을 신청했습니다! (판돈: ${formatMoney(amount)}원)\n<@${targetId}>님은 \`!수락 ${duelId} [내계좌번호]\` 명령어로 대결을 받아주세요!`);
      }

      // PvE 모드
      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);

      const p1 = Math.floor(Math.random() * 6) + 1;
      const p2 = Math.floor(Math.random() * 6) + 1;
      const b1 = Math.floor(Math.random() * 6) + 1;
      const b2 = Math.floor(Math.random() * 6) + 1;

      const pSum = p1 + p2;
      const bSum = b1 + b2;

      let msg = `🎲 **주사위배틀 결과**\n👤 플레이어: [${p1}, ${p2}] (합: **${pSum}**)\n🤖 봇: [${b1}, ${b2}] (합: **${bSum}**)\n\n`;

      if (pSum > bSum) {
        const winAmount = amount * 2n;
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, accNum);
        msg += `🎉 **승리!** **${winAmount.toLocaleString()}원** 획득!`;
      } else if (pSum === bSum) {
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);
        msg += `🤝 **무승부!** 베팅금을 돌려받았습니다.`;
      } else {
        msg += `💸 **패배...** 베팅금을 잃었습니다.`;
      }
      message.reply(msg);
    }

    // --- 대결 수락/거절 ---
    if (command === "!수락") {
      const duelId = args[1];
      const accNum = args[2];
      
      if (!duelId || !accNum) return message.reply("❌ 사용법: `!수락 [대결ID] [내계좌번호]`");
      
      const duel = activeDuels.get(duelId);
      if (!duel) return message.reply("❌ 존재하지 않거나 이미 만료된 대결입니다.");
      if (duel.p2 !== message.author.id) return message.reply("❌ 본인에게 신청된 대결이 아닙니다.");

      const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
      if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
      if (account.balance < duel.amount) return message.reply(`❌ 계좌 잔액이 부족합니다. (필요: ${formatMoney(duel.amount)}원)`);

      // 양측 돈 차감
      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(duel.amount, duel.p1Acc);
      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(duel.amount, accNum);
      duel.p2Acc = accNum;

      if (duel.type === 'dice') {
        // 주사위 굴리기
        const p1_1 = Math.floor(Math.random() * 6) + 1;
        const p1_2 = Math.floor(Math.random() * 6) + 1;
        const p2_1 = Math.floor(Math.random() * 6) + 1;
        const p2_2 = Math.floor(Math.random() * 6) + 1;

        const p1Sum = p1_1 + p1_2;
        const p2Sum = p2_1 + p2_2;

        let msg = `🎲 **PvP 주사위배틀 결과** 🎲\n\n👤 <@${duel.p1}>: [${p1_1}, ${p1_2}] (합: **${p1Sum}**)\n👤 <@${duel.p2}>: [${p2_1}, ${p2_2}] (합: **${p2Sum}**)\n\n`;

        if (p1Sum > p2Sum) {
          const winAmount = duel.amount * 2n;
          db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, duel.p1Acc);
          msg += `🎉 **<@${duel.p1}> 승리!** **${winAmount.toLocaleString()}원**을 독식했습니다!`;
        } else if (p2Sum > p1Sum) {
          const winAmount = duel.amount * 2n;
          db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, duel.p2Acc);
          msg += `🎉 **<@${duel.p2}> 승리!** **${winAmount.toLocaleString()}원**을 독식했습니다!`;
        } else {
          db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(duel.amount, duel.p1Acc);
          db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(duel.amount, duel.p2Acc);
          msg += `🤝 **무승부!** 양쪽 모두 베팅금을 돌려받았습니다.`;
        }
        activeDuels.delete(duelId);
        message.reply(msg);
      } else if (duel.type === 'rps') {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`rps_${duelId}_가위`).setLabel('✌️ 가위').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`rps_${duelId}_바위`).setLabel('✊ 바위').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`rps_${duelId}_보`).setLabel('🖐️ 보').setStyle(ButtonStyle.Primary)
        );
        const sentMsg = await message.reply({
          content: `⚔️ **PvP 가위바위보 대결 성사!** (판돈: ${formatMoney(duel.amount)}원)\n<@${duel.p1}>님과 <@${duel.p2}>님은 아래 버튼을 눌러 비밀리에 선택해주세요!`,
          components: [row]
        });
        duel.messageId = sentMsg.id;
      }
    }

    if (command === "!거절") {
      const duelId = args[1];
      if (!duelId) return message.reply("❌ 사용법: `!거절 [대결ID]`");
      
      const duel = activeDuels.get(duelId);
      if (!duel) return message.reply("❌ 존재하지 않거나 이미 만료된 대결입니다.");
      if (duel.p2 !== message.author.id) return message.reply("❌ 본인에게 신청된 대결이 아닙니다.");

      activeDuels.delete(duelId);
      message.reply(`🚫 <@${message.author.id}>님이 대결을 거절했습니다.`);
    }

    // --- 포커 명령어 ---
    if (command === "!포커") {
      if (args.length < 3) {
        return message.reply("🃏 **비디오 포커(Video Poker) 게임 설명**\n5장의 카드를 받고, 원하는 카드를 1회 교체하여 높은 포커 족보를 완성하는 게임입니다.\n\n**[진행 방법]**\n1. 게임을 시작하면 5장의 카드가 주어집니다.\n2. 버튼을 눌러 **유지할 카드(초록색)**를 선택합니다.\n3. `Draw` 버튼을 누르면 선택하지 않은 나머지 카드가 새로운 카드로 1회 교체됩니다.\n\n**[족보 설명 및 배당률]**\n- **로얄 플러쉬 (250배)**: 무늬가 같고 10, J, Q, K, A가 연속으로 나옴\n- **스트레이트 플러쉬 (50배)**: 무늬가 같고 5장의 숫자가 연속으로 나옴\n- **포카드 (25배)**: 같은 숫자 4장\n- **풀하우스 (9배)**: 같은 숫자 3장 + 같은 숫자 2장\n- **플러쉬 (6배)**: 무늬가 같은 카드 5장\n- **스트레이트 (4배)**: 무늬 상관없이 5장의 숫자가 연속으로 나옴\n- **트리플 (3배)**: 같은 숫자 3장\n- **투페어 (2배)**: 같은 숫자 2장씩 두 쌍\n- **원페어 (1배, 본전)**: 같은 숫자 2장 한 쌍 (단, J, Q, K, A 중 하나로만 이루어진 페어여야 인정. 예: J-J, Q-Q 등)\n\n👉 **사용법**: `!포커 [베팅금액] [내계좌번호]`");
      }
      const amount = parseMoney(args[1]);
      const accNum = args[2];
      if (amount === null || amount <= 0n || !accNum) return message.reply("❌ 사용법: `!포커 [베팅금액] [내계좌번호]`");

      if (activePokers.has(message.author.id)) {
        return message.reply("❌ 이미 진행 중인 포커 게임이 있습니다.");
      }

      const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
      if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
      if (BigInt(account.balance) < amount) return message.reply("❌ 계좌 잔액이 부족합니다.");

      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);

      const deck = getDeck();
      const hand = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
      const held = [false, false, false, false, false];

      activePokers.set(message.author.id, {
        userId: message.author.id,
        accNum,
        amount,
        deck,
        hand,
        held
      });

      const row1 = new ActionRowBuilder<ButtonBuilder>();
      for (let i = 0; i < 5; i++) {
        const card = hand[i];
        row1.addComponents(
          new ButtonBuilder().setCustomId(`poker_${i}`).setLabel(card.suit + card.value).setStyle(ButtonStyle.Secondary)
        );
      }
      
      const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('poker_draw').setLabel('선택한 카드 유지하고 나머지 교체 (Draw)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('poker_done').setLabel('그대로 승부 (Stand)').setStyle(ButtonStyle.Danger)
      );

      message.reply({
        content: `🃏 **비디오 포커 시작!** (베팅: ${formatMoney(amount)}원)\n버튼을 눌러 **유지할 카드(초록색)**를 선택한 후 Draw를 누르세요.`,
        components: [row1, row2]
      });
    }

    // --- 로또 명령어 ---
    if (command === "!로또") {
      if (args.length < 6) {
        return message.reply("🎟️ **즉석 로또 게임 설명**\n1부터 9까지의 숫자 중 서로 다른 **3개의 숫자**를 골라 봇이 추첨한 당첨 번호 3개와 비교하는 게임입니다.\n\n**[당첨금]**\n- **3개 모두 적중**: 베팅금의 **100배** (초대박 잭팟!)\n- **2개 적중**: 베팅금의 **10배**\n- **1개 이하 적중**: 꽝 (베팅금 증발)\n\n👉 **사용법**: `!로또 [베팅금액] [내계좌번호] [숫자1] [숫자2] [숫자3]`\n예시: `!로또 10000 1-1234-5678 3 7 9`");
      }
      const amount = parseMoney(args[1]);
      const accNum = args[2];
      const n1 = parseInt(args[3]);
      const n2 = parseInt(args[4]);
      const n3 = parseInt(args[5]);

      if (amount === null || amount <= 0n || !accNum || isNaN(n1) || isNaN(n2) || isNaN(n3)) {
        return message.reply("❌ 사용법: `!로또 [금액] [내계좌번호] [숫자1] [숫자2] [숫자3]`");
      }

      const userNums = [n1, n2, n3];
      if (userNums.some(n => n < 1 || n > 9) || new Set(userNums).size !== 3) {
        return message.reply("❌ 숫자는 1부터 9까지 서로 다른 3개의 숫자여야 합니다.");
      }

      const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
      if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
      if (BigInt(account.balance) < amount) return message.reply("❌ 계좌 잔액이 부족합니다.");

      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);

      // Draw 3 unique random numbers 1~9
      const pool = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const winningNums = pool.slice(0, 3).sort();
      userNums.sort();

      let matchCount = 0;
      for (const n of userNums) {
        if (winningNums.includes(n)) matchCount++;
      }

      let multiplier = 0;
      if (matchCount === 3) multiplier = 100;
      else if (matchCount === 2) multiplier = 10;

      let msg = `🎟️ **즉석 로또 결과**\n당첨 번호: **[ ${winningNums.join(', ')} ]**\n내 번호: **[ ${userNums.join(', ')} ]**\n일치하는 숫자: **${matchCount}개**\n\n`;

      if (multiplier > 0) {
        const winAmount = amount * BigInt(multiplier);
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(winAmount, accNum);
        msg += `🎉 **축하합니다! ${multiplier}배 당첨!** **${winAmount.toLocaleString()}원** 획득!`;
      } else {
        msg += `💸 **꽝...** 베팅금을 잃었습니다.`;
      }
      message.reply(msg);
    }

    // --- 야추 다이스 명령어 ---
    if (command === "!야추" || command === "!야추다이스") {
      if (args.length < 3) {
        return message.reply("🎲 **야추 다이스(Yacht Dice) 게임 설명**\n5개의 주사위를 굴려 총 12개의 족보를 채워 높은 점수를 얻는 전략 주사위 게임입니다.\n\n**[진행 방법]**\n1. 매 턴마다 주사위를 굴립니다. (최대 2번 더 다시 굴리기 가능)\n2. 원하는 주사위는 버튼을 눌러 **유지(Hold)**할 수 있습니다.\n3. 주사위 굴리기가 끝나면 드롭다운 메뉴에서 점수를 기록할 **족보**를 선택합니다.\n4. 총 12턴을 진행하여 모든 족보를 채우면 게임이 종료됩니다.\n*(상단 6개 항목의 합이 63점 이상이면 +35점 보너스!)*\n\n**[최종 점수별 배당률]**\n- **100점 이상**: 1배 (본전 환불)\n- **150점 이상**: 2배\n- **200점 이상**: 5배\n- **250점 이상**: 10배\n- **300점 이상**: **50배** (초대박!)\n\n👉 **사용법**: `!야추 [베팅금액] [내계좌번호]`");
      }
      const amount = parseMoney(args[1]);
      const accNum = args[2];
      if (amount === null || amount <= 0n || !accNum) return message.reply("❌ 사용법: `!야추 [베팅금액] [내계좌번호]`");

      if (activeYachts.has(message.author.id)) return message.reply("❌ 이미 진행 중인 야추 게임이 있습니다.");

      const account = db.prepare("SELECT * FROM bank_accounts WHERE userId = ? AND account_number = ?").get(message.author.id, accNum);
      if (!account) return message.reply("❌ 본인 소유의 유효한 계좌번호가 아닙니다.");
      if (BigInt(account.balance) < amount) return message.reply("❌ 계좌 잔액이 부족합니다.");

      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);

      const dice = [
        Math.floor(Math.random() * 6) + 1,
        Math.floor(Math.random() * 6) + 1,
        Math.floor(Math.random() * 6) + 1,
        Math.floor(Math.random() * 6) + 1,
        Math.floor(Math.random() * 6) + 1
      ];

      const gameState = {
        userId: message.author.id,
        accNum,
        amount,
        dice,
        held: [false, false, false, false, false],
        rollsLeft: 2,
        turn: 1,
        scores: {
          aces: null, deuces: null, threes: null, fours: null, fives: null, sixes: null,
          choice: null, four_of_a_kind: null, full_house: null, small_straight: null, large_straight: null, yacht: null
        }
      };
      activeYachts.set(message.author.id, gameState);

      message.reply(buildYachtUI(gameState));
    }

    // --- 도박/게임 취소 명령어 ---
    if (command === "!도박취소" || command === "!게임취소") {
      let targetId = message.author.id;
      const isUserAdmin = checkAdmin();
      
      if (args[1] && args[1].startsWith("<@") && args[1].endsWith(">")) {
        if (!isUserAdmin) return message.reply("❌ 다른 유저의 게임을 강제 취소하려면 관리자 권한이 필요합니다.");
        targetId = args[1].replace(/[<@!>]/g, "");
      }

      let refunded = false;
      let refundMsg = "";

      if (activeBlackjacks.has(targetId)) {
        const game = activeBlackjacks.get(targetId);
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(game.amount, game.accNum);
        activeBlackjacks.delete(targetId);
        refunded = true;
        refundMsg = `블랙잭 게임이 취소되었으며 베팅금 **${formatMoney(game.amount)}원**이 환불되었습니다.`;
      } else if (activePokers.has(targetId)) {
        const game = activePokers.get(targetId);
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(game.amount, game.accNum);
        activePokers.delete(targetId);
        refunded = true;
        refundMsg = `포커 게임이 취소되었으며 베팅금 **${formatMoney(game.amount)}원**이 환불되었습니다.`;
      } else if (activeYachts.has(targetId)) {
        const game = activeYachts.get(targetId);
        db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(game.amount, game.accNum);
        activeYachts.delete(targetId);
        refunded = true;
        refundMsg = `야추 다이스 게임이 취소되었으며 베팅금 **${formatMoney(game.amount)}원**이 환불되었습니다.`;
      } else {
        let myDuelId = null;
        let myDuel: any = null;
        for (const [duelId, duel] of activeDuels.entries()) {
          if (duel.p1 === targetId || duel.p2 === targetId) {
            myDuelId = duelId;
            myDuel = duel;
            break;
          }
        }

        if (myDuel && myDuelId) {
          if (myDuel.p1 === targetId || (myDuel.p2 === targetId && myDuel.p2Acc) || isUserAdmin) {
            if (myDuel.p1Acc) {
              db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(myDuel.amount, myDuel.p1Acc);
            }
            if (myDuel.p2Acc) {
              db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(myDuel.amount, myDuel.p2Acc);
            }
            activeDuels.delete(myDuelId);
            refunded = true;
            refundMsg = `진행 중이던 PvP 대결이 취소되었으며, 참여자들의 베팅금이 모두 환불되었습니다.`;
          } else {
             return message.reply("❌ 대결 신청자만 취소할 수 있습니다. (상대방은 `!거절`을 사용하세요)");
          }
        }
      }

      if (refunded) {
        message.reply(`✅ **취소 완료!** <@${targetId}>님의\n${refundMsg}`);
      } else {
        message.reply(`❌ <@${targetId}>님이 현재 진행 중인 게임이 없습니다.`);
      }
    }

    // --- 관리자/설정 명령어 ---
    const isAdmin = checkAdmin();

    if (command === "!주식설정") {
      if (!isAdmin) return message.reply("❌ 관리자 권한이 필요합니다.");
      const type = args[1]; // 시간 or 범위
      const value = parseInt(args[2]);

      if (type === "시간") {
        if (isNaN(value) || value < 5) return message.reply("❌ 시간은 최소 5초 이상이어야 합니다.");
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('update_interval', ?)").run(value.toString());
        startStockTimer();
        message.reply(`⚙️ 주가 변동 주기가 **${value}초**로 변경되었습니다.`);
      } else if (type === "범위") {
        if (isNaN(value) || value < 1 || value > 100) return message.reply("❌ 범위는 1%에서 100% 사이여야 합니다.");
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('fluctuation_range', ?)").run(value.toString());
        message.reply(`⚙️ 주가 변동 범위가 **±${value}%**로 변경되었습니다.`);
      } else {
        message.reply("❌ 사용법: `!주식설정 [시간/범위] [값]`");
      }
    }

    if (command === "!주식초기화값") {
      if (!isAdmin) return message.reply("❌ 관리자 권한이 필요합니다.");
      const symbol = args[1]?.toUpperCase();
      const price = parseMoney(args[2]);
      if (!symbol || price === null || price <= 0n) return message.reply("❌ 사용법: `!주식초기화값 [코드] [가격]`");
      
      const stock = db.prepare("SELECT * FROM stocks WHERE symbol = ?").get(symbol);
      if (!stock) return message.reply("❌ 존재하지 않는 종목입니다.");
      
      db.prepare("UPDATE stocks SET reset_price = ? WHERE symbol = ?").run(price, symbol);
      message.reply(`⚙️ **${stock.name}(${symbol})**의 초기화 가격이 **${formatMoney(price)}원**으로 설정되었습니다.`);
    }

    if (command === "!주식초기화시간" || (command === "!주식" && args[1] === "초기화시간")) {
      if (!isAdmin) return message.reply("❌ 관리자 권한이 필요합니다.");
      
      const action = command === "!주식초기화시간" ? args[1] : args[2];
      const ampm = command === "!주식초기화시간" ? args[2] : args[3];
      const hourStr = command === "!주식초기화시간" ? args[3] : args[4];
      
      if (action === "기본") {
        db.prepare("DELETE FROM settings WHERE key = 'stock_reset_hours'").run();
        return message.reply("⚙️ 주식 초기화 시간이 기본값(오전 4시, 오후 12시)으로 복구되었습니다.");
      }

      const getSavedHours = () => {
        const setting = db.prepare("SELECT value FROM settings WHERE key = 'stock_reset_hours'").get();
        if (setting) {
          try { return JSON.parse(setting.value); } catch(e) { return [4, 12]; }
        }
        return [4, 12];
      };

      if (action === "목록") {
        const hours = getSavedHours();
        if (hours.length === 0) return message.reply("⚙️ 현재 설정된 주식 초기화 시간이 없습니다. (자동 초기화 안 됨)");
        const formatted = hours.map((h: number) => {
          const ampmStr = h < 12 ? "오전" : "오후";
          const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
          return `${ampmStr} ${displayHour}시`;
        }).join(", ");
        return message.reply(`⚙️ **현재 주식 초기화 시간 목록:**\n${formatted}`);
      }

      if (!action || !["추가", "제거"].includes(action) || !ampm || !["오전", "오후"].includes(ampm) || !hourStr) {
        return message.reply("❌ 사용법:\n`!주식 초기화시간 추가 [오전/오후] [1~12]`\n`!주식 초기화시간 제거 [오전/오후] [1~12]`\n`!주식 초기화시간 목록`\n`!주식 초기화시간 기본`");
      }
      
      let hour = parseInt(hourStr);
      if (isNaN(hour) || hour < 1 || hour > 12) {
        return message.reply("❌ 시간은 1에서 12 사이의 숫자로 입력해주세요.");
      }
      
      if (ampm === "오후" && hour !== 12) hour += 12;
      if (ampm === "오전" && hour === 12) hour = 0;
      
      let currentHours = getSavedHours();

      if (action === "추가") {
        if (currentHours.includes(hour)) {
          return message.reply(`⚠️ 이미 **${ampm} ${hourStr}시**가 초기화 시간에 포함되어 있습니다.`);
        }
        currentHours.push(hour);
        currentHours.sort((a: number, b: number) => a - b);
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('stock_reset_hours', ?)").run(JSON.stringify(currentHours));
        message.reply(`⚙️ 주식 초기화 시간에 **${ampm} ${hourStr}시**가 추가되었습니다. (\`!주식 초기화시간 목록\`으로 확인)`);
      } else if (action === "제거") {
        if (!currentHours.includes(hour)) {
          return message.reply(`⚠️ **${ampm} ${hourStr}시**는 초기화 시간에 포함되어 있지 않습니다.`);
        }
        currentHours = currentHours.filter((h: number) => h !== hour);
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('stock_reset_hours', ?)").run(JSON.stringify(currentHours));
        message.reply(`⚙️ 주식 초기화 시간에서 **${ampm} ${hourStr}시**가 제거되었습니다.`);
      }
    }

    if (command === "!이자시간") {
      if (!isAdmin) return message.reply("❌ 관리자 권한이 필요합니다.");
      const minutes = parseInt(args[1]);
      if (isNaN(minutes) || minutes < 1) return message.reply("❌ 사용법: `!이자시간 [분]`");
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('bank_interval', ?)").run(minutes.toString());
      startBankTimer();
      message.reply(`⚙️ 은행 이자 및 대출 정산 주기가 **${minutes}분**으로 변경되었습니다.`);
    }

    if (command === "!채굴시간") {
      if (!isAdmin) return message.reply("❌ 관리자 권한이 필요합니다.");
      const minutes = parseInt(args[1]);
      if (isNaN(minutes) || minutes < 1) return message.reply("❌ 사용법: `!채굴시간 [분]`");
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('mine_interval', ?)").run(minutes.toString());
      startMineTimer();
      message.reply(`⚙️ BTC 채굴 주기가 **${minutes}분**으로 변경되었습니다.`);
    }

    if (command === "!주가조작") {
      if (!isAdmin) return message.reply("❌ 관리자 권한이 필요합니다.");
      const symbol = args[1]?.toUpperCase();
      const price = parseMoney(args[2]);

      if (!symbol || price === null || price <= 0n) return message.reply("❌ 사용법: `!주가조작 [코드] [가격]`");

      const stock = db.prepare("SELECT * FROM stocks WHERE symbol = ?").get(symbol);
      if (!stock) return message.reply("❌ 존재하지 않는 종목입니다.");

      db.prepare("UPDATE stocks SET last_price = price, price = ? WHERE symbol = ?").run(price, symbol);
      message.reply(`🚨 **주가 조작 발생!** **${stock.name}**의 가격이 **${formatMoney(price)}원**으로 강제 고정되었습니다.`);
      addLog(`관리자(${message.author.tag})가 ${stock.name} 주가 조작: ${price}원`);
    }

    if (command === "!주식추가") {
      if (!isAdmin) return message.reply("❌ 관리자 권한이 필요합니다.");
      const symbol = args[1]?.toUpperCase();
      const name = args[2];
      const price = parseMoney(args[3]);

      if (!symbol || !name || price === null) return message.reply("❌ 사용법: `!주식추가 [코드] [이름] [가격]`");

      db.prepare("INSERT OR REPLACE INTO stocks (symbol, name, price, last_price) VALUES (?, ?, ?, ?)")
        .run(symbol, name, price, price);
      message.reply(`✅ 새로운 주식 **${name}(${symbol})**이 **${formatMoney(price)}원**으로 상장되었습니다.`);
    }

    if (command === "!주식제거") {
      if (!isAdmin) return message.reply("❌ 관리자 권한이 필요합니다.");
      const symbol = args[1]?.toUpperCase();
      if (!symbol) return message.reply("❌ 사용법: `!주식제거 [코드]`");

      db.prepare("DELETE FROM stocks WHERE symbol = ?").run(symbol);
      message.reply(`✅ 주식 **${symbol}**이 상장 폐지되었습니다.`);
    }

    if (command === "!돈주기") {
      if (!isAdmin) return message.reply("❌ 관리자 권한이 필요합니다.");
      const accNum = args[1];
      const amount = parseMoney(args[2]);

      if (!accNum || amount === null) return message.reply("❌ 사용법: `!돈주기 [계좌번호] [금액]`");

      const account = db.prepare("SELECT userId, bankId FROM bank_accounts WHERE account_number = ?").get(accNum);
      if (!account) return message.reply("❌ 존재하지 않는 계좌번호입니다.");

      db.prepare("UPDATE bank_accounts SET balance = addBigInt(balance, ?) WHERE account_number = ?").run(amount, accNum);
      message.reply(`✅ **${accNum}** 계좌에 **${formatMoney(amount)}원**을 지급했습니다.`);
    }

    if (command === "!압류") {
      if (!isAdmin) return message.reply("❌ 관리자 권한이 필요합니다.");
      const accNum = args[1];
      const amount = parseMoney(args[2]);

      if (!accNum || amount === null) return message.reply("❌ 사용법: `!압류 [계좌번호] [금액]`");

      const account = db.prepare("SELECT userId, balance FROM bank_accounts WHERE account_number = ?").get(accNum);
      if (!account) return message.reply("❌ 존재하지 않는 계좌번호입니다.");

      const actualSeizure = BigInt(account.balance) < amount ? BigInt(account.balance) : amount;
      db.prepare("UPDATE bank_accounts SET balance = subBigInt(balance, ?) WHERE account_number = ?").run(actualSeizure, accNum);
      message.reply(`🚨 **${accNum}** 계좌에서 **${formatMoney(actualSeizure)}원**을 압류했습니다.`);
    }

    if (command === "!강제매도") {
      if (!isAdmin) return message.reply("❌ 관리자 권한이 필요합니다.");
      const accNum = args[1];
      const symbol = args[2]?.toUpperCase();

      if (!accNum || !symbol) return message.reply("❌ 사용법: `!강제매도 [계좌번호] [종목코드]`");

      const account = db.prepare("SELECT userId FROM bank_accounts WHERE account_number = ?").get(accNum);
      if (!account) return message.reply("❌ 존재하지 않는 계좌번호입니다.");

      const stock = db.prepare("SELECT * FROM stocks WHERE symbol = ?").get(symbol);
      const hold = db.prepare("SELECT quantity FROM portfolio WHERE userId = ? AND symbol = ?").get(account.userId, symbol);

      if (!stock || !hold || hold.quantity <= 0) return message.reply("❌ 해당 유저가 보유한 주식이 없습니다.");

      const total = stock.price * hold.quantity;
      depositToBank(account.userId, total);
      db.prepare("DELETE FROM portfolio WHERE userId = ? AND symbol = ?").run(account.userId, symbol);
      
      message.reply(`🚨 **${accNum}** 계좌 소유주의 **${stock.name}** ${hold.quantity}주를 **${total.toLocaleString()}원**에 강제 매도 처리했습니다. (은행 입금 완료)`);
    }

    if (command === "!파산") {
      if (!isAdmin) return message.reply("❌ 관리자 권한이 필요합니다.");
      let targetId = args[1];
      if (!targetId) return message.reply("❌ 사용법: `!파산 [@유저멘션 또는 유저ID]`");

      // 멘션인 경우 ID만 추출 (<@123456789> -> 123456789)
      if (targetId.startsWith("<@") && targetId.endsWith(">")) {
        targetId = targetId.replace(/[<@!>]/g, "");
      }

      // 1. 모든 은행 잔고 0으로 만들기
      db.prepare("UPDATE bank_accounts SET balance = 0 WHERE userId = ?").run(targetId);
      // 2. 대출 기록 모두 삭제
      db.prepare("DELETE FROM loans WHERE userId = ?").run(targetId);
      // 3. BTC 잔고 0으로 만들기
      db.prepare("UPDATE users SET btc_balance = 0 WHERE id = ?").run(targetId);

      message.reply(`🚨 **집행 완료!** <@${targetId}> 님의 모든 은행 잔고와 BTC가 0원이 되었으며, 모든 대출 기록이 소멸되었습니다.`);
    }

    if (command === "!명령어") {
      let reply = "📜 **사용 가능한 명령어 목록**\n\n";
      reply += "**💰 경제 & 도박**\n";
      reply += "`!출석`: 하루 한 번 1만 원 지급 (은행 계좌로 자동 입금)\n";
      reply += "`!돈`: 내 은행 계좌 잔액 및 BTC 보유량 확인\n";
      reply += "`!이체 [내계좌] [상대계좌] [금액]`: 계좌 간 송금\n";
      reply += "`!내계좌이체 [출금은행] [입금은행] [금액]`: 내 계좌 간 간편 이체\n";
      reply += "`!도박 [금액] [내계좌번호]`: 50% 확률로 베팅\n";
      reply += "`!블랙잭 [금액] [내계좌번호]`: 딜러와 블랙잭 승부\n";
      reply += "`!포커 [금액] [내계좌번호]`: 비디오 포커 (로얄 플러쉬 250배)\n";
      reply += "`!슬롯머신 [금액] [내계좌번호]`: 슬롯머신 돌리기\n";
      reply += "`!홀짝 [금액] [내계좌번호] [홀/짝]`: 주사위 홀짝 맞히기\n";
      reply += "`!경마 [금액] [내계좌번호] [말번호(1~4)]`: 4배당 경마 베팅\n";
      reply += "`!가위바위보 [금액] [내계좌번호] [@유저(선택)]`: 봇 또는 유저와 가위바위보\n";
      reply += "`!룰렛 [금액] [내계좌번호] [빨강/검정/초록]`: 룰렛 베팅 (초록 14배)\n";
      reply += "`!크래시 [금액] [내계좌번호] [목표배수]`: 상승하는 배수 맞히기\n";
      reply += "`!주사위배틀 [금액] [내계좌번호] [@유저(선택)]`: 봇 또는 유저와 주사위 승부\n";
      reply += "`!로또 [금액] [내계좌번호] [숫자1] [숫자2] [숫자3]`: 1~9 중 3개 맞히기 (최대 100배)\n";
      reply += "`!야추 [금액] [내계좌번호]`: 12턴 야추 다이스 플레이\n";
      reply += "`!도박취소 [@유저(선택)]`: 진행 중인 게임 강제 종료 및 환불\n";
      reply += "`!상점`: 칭호 등 아이템 구매\n";
      reply += "`!안녕`: 봇 상태 확인\n\n";
      
      reply += "**🏦 은행 & 대출**\n";
      reply += "`!은행`: 내 계좌 정보 및 은행별 예금/대출 이율 확인\n";
      reply += "`!은행 가입 [1/2/3]`: 계좌 개설\n";
      reply += "`!은행 목록`: 전체 계좌 조회\n";
      reply += "`!대출 신청 [은행번호] [금액] [기간] [입금받을계좌번호]`: 지정한 계좌로 대출금 수령 (교차 은행 가능)\n";
      reply += "`!대출 상환 [ID] [금액] [출금계좌]`: 대출금 부분/전액 상환\n";
      reply += "`!대출 일괄상환 [출금계좌]`: 모든 대출금을 한 번에 상환\n\n";

      reply += "**⛏️ BTC 채굴**\n";
      reply += "`!채굴 상점`: 채굴 기기 목록 및 가격 확인\n";
      reply += "`!채굴 구매 [ID] [수량/전부] [계좌]`: 기기 구매\n";
      reply += "`!채굴 슬롯확장 [계좌] [횟수]`: 1억 원당 5칸 추가 (최대 3000칸)\n";
      reply += "`!채굴 판매 [소유ID] [계좌]`: 기기 중고 판매 (50% 환급)\n";
      reply += "`!채굴 현황`: 내 기기 목록 및 해시레이트 확인\n";
      reply += "`!채굴 정산 [수량/전부] [계좌]`: 채굴한 BTC를 계좌로 환전 (1 BTC = 1억 원)\n\n";
      
      reply += "**📈 주식 시스템**\n";
      reply += "`!주식`: 현재 시세 확인\n";
      reply += "`!주식 그래프 [코드]`: 최근 15회 시세 변동 그래프\n";
      reply += "`!주식알림 켜기/끄기 [코드]`: 주가 변동 시 알림 받기\n";
      reply += "`!내주식`: 내 포트폴리오 확인\n";
      reply += "`!매수/매도 [코드] [수량] [내계좌번호]`: 주식 거래\n\n";
      
      if (isAdmin) {
        reply += "**🛡️ 관리자 전용**\n";
        reply += "`!주식설정 [시간/범위] [값]`, `!주가조작 [코드] [가격]`, `!주식추가 [코드] [이름] [가격]`, `!주식제거 [코드]`, `!돈주기 [계좌번호] [금액]`, `!압류 [계좌번호] [금액]`, `!강제매도 [계좌번호] [코드]`\n";
        reply += "`!주식초기화값 [코드] [가격]`, `!주식초기화시간 [추가/제거/목록/기본]`, `!이자시간 [분]`, `!채굴시간 [분]`, `!파산 [@유저멘션]`";
      }
      await sendChunkedMessage(message, reply);
    }
  } catch (err: any) {
    addLog(`명령어 처리 중 오류: ${err.message}`);
  }
});

// --- API 경로 ---
app.get(["/api/status", "/bot/api/status"], (req, res) => {
  res.json({ status: botStatus, user: botUser, logs: logs.slice().reverse() });
});

app.post(["/api/login", "/bot/api/login"], express.json(), async (req, res) => {
  const { token } = req.body;
  addLog("웹 대시보드에서 수동 로그인을 시도합니다...");
  
  if (!token || token.length < 50) {
    addLog("오류: 유효하지 않은 토큰 형식입니다.");
    return res.status(400).json({ error: "유효하지 않은 토큰 형식입니다." });
  }

  try {
    // 기존 연결이 있다면 종료 시도 (선택 사항)
    if (client.isReady()) {
      addLog("기존 연결을 종료하고 새로 로그인합니다.");
      client.destroy();
    }
    
    await client.login(token);
    res.json({ success: true });
  } catch (err: any) {
    let errorMsg = err.message;
    if (errorMsg.includes("TOKEN_INVALID")) {
      errorMsg = "잘못된 토큰입니다. 디스코드 개발자 포털에서 토큰을 다시 확인하세요.";
    } else if (errorMsg.includes("PRIVILEGED_INTENTS_REQUIRED")) {
      errorMsg = "인텐트 설정이 필요합니다! 개발자 포털에서 'Gateway Intents' 3개를 모두 켜주세요.";
    }
    addLog(`로그인 실패: ${errorMsg}`);
    res.status(500).json({ error: errorMsg });
  }
});

// --- 서버 실행 ---
async function start() {
  try {
    if (process.env.NODE_ENV !== "production") {
      const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
      app.use(vite.middlewares);
    } else {
      const distPath = path.join(process.cwd(), 'dist');
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
    
    app.listen(PORT, "0.0.0.0", () => {
      addLog(`서버가 포트 ${PORT}에서 시작되었습니다.`);
    });

    // 환경변수에 토큰이 있으면 자동 로그인
    if (process.env.DISCORD_TOKEN) {
      client.login(process.env.DISCORD_TOKEN).catch(e => {
        botStatus = "로그인 실패";
        addLog(`자동 로그인 실패: ${e.message}`);
        if (e.message.includes("PRIVILEGED_INTENTS")) {
          addLog("⚠️ 중요: 디스코드 개발자 포털에서 'Message Content Intent'를 활성화해야 합니다!");
        }
      });
    } else {
      botStatus = "토큰 없음";
      addLog("⚠️ 알림: DISCORD_TOKEN 환경 변수가 설정되지 않았습니다. 웹 대시보드에서 로그인하거나 환경 변수를 설정하세요.");
    }
  } catch (err: any) {
    console.error("서버 시작 오류:", err);
  }
}

start();

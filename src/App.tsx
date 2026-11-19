import React, { useState, useEffect } from "react";
import { 
  Activity, 
  Terminal, 
  User, 
  MessageSquare, 
  RefreshCw, 
  ShieldCheck,
  ExternalLink,
  Bot
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface BotInfo {
  status: string;
  user: {
    username: string;
    tag: string;
    id: string;
    avatar: string;
  } | null;
  logs: string[];
}

export default function App() {
  const [botInfo, setBotInfo] = useState<BotInfo>({
    status: "로딩 중...",
    user: null,
    logs: [],
  });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [clientId, setClientId] = useState("");

  const generateInviteLink = () => {
    if (!clientId.trim()) return "";
    return `https://discord.com/api/oauth2/authorize?client_id=${clientId.trim()}&permissions=8&scope=bot%20applications.commands`;
  };

  const fetchStatus = async () => {
    setIsRefreshing(true);
    try {
      const response = await fetch("api/status");
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`서버 오류 (${response.status}): ${text.slice(0, 100)}`);
      }
      const data = await response.json();
      setBotInfo(data);
    } catch (error: any) {
      console.error("봇 상태를 가져오지 못했습니다:", error);
      setLoginError(`상태 업데이트 실패: ${error.message}`);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleManualLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualToken.trim()) return;

    setIsLoggingIn(true);
    setLoginError("");
    try {
      const response = await fetch("api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: manualToken }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "로그인 실패");
      
      setManualToken("");
      fetchStatus();
    } catch (error: any) {
      setLoginError(error.message);
    } finally {
      setIsLoggingIn(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-[#0F172A] text-slate-200 font-sans selection:bg-indigo-500/30">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-600 p-2 rounded-lg">
              <Bot className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-white">디스코드 봇 매니저</h1>
          </div>
          <button 
            onClick={fetchStatus}
            disabled={isRefreshing}
            className="flex items-center gap-2 px-4 py-2 rounded-full bg-slate-800 hover:bg-slate-700 transition-colors text-sm font-medium border border-slate-700"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? "animate-spin" : ""}`} />
            새로고침
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Status & Info */}
        <div className="lg:col-span-1 space-y-6">
          {/* Status Card */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl"
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">봇 상태</h2>
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${
                  botInfo.status === "온라인" ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" : 
                  botInfo.status === "연결 끊김" || botInfo.status === "로그인 실패" ? "bg-rose-500" : 
                  botInfo.status === "재연결 중" ? "bg-amber-500 animate-pulse" : "bg-slate-600"
                }`} />
                <span className="text-sm font-medium">{botInfo.status}</span>
              </div>
            </div>

            {botInfo.status !== "온라인" && (
              <div className="mb-6 p-3 bg-rose-500/10 border border-rose-500/20 rounded-lg text-xs text-rose-400">
                <p className="font-bold mb-1">⚠️ 봇이 오프라인입니다.</p>
                <p>1. 디스코드 개발자 포털에서 <strong>Message Content Intent</strong>가 켜져 있는지 확인하세요.</p>
                <p className="mt-1">2. <strong>DISCORD_TOKEN</strong> 환경 변수가 올바른지 확인하세요.</p>
              </div>
            )}

            {botInfo.user ? (
              <div className="flex flex-col items-center text-center">
                <div className="relative mb-4">
                  <img 
                    src={botInfo.user.avatar} 
                    alt="Bot Avatar" 
                    className="w-24 h-24 rounded-full border-4 border-slate-800 shadow-2xl"
                    referrerPolicy="no-referrer"
                  />
                  <div className="absolute bottom-1 right-1 w-6 h-6 bg-emerald-500 border-4 border-slate-900 rounded-full" />
                </div>
                <h3 className="text-xl font-bold text-white">{botInfo.user.username}</h3>
                <p className="text-slate-400 text-sm mb-4">#{botInfo.user.tag.split('#')[1] || '0000'}</p>
                
                <div className="w-full space-y-3 mt-4">
                  <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                    <p className="text-[10px] uppercase text-slate-500 font-bold mb-2">💰 경제 & 도박</p>
                    <div className="grid grid-cols-1 gap-2 text-[11px] font-mono text-indigo-300">
                      <span>!출석 - 3만 원 지급 (은행 계좌로 입금)</span>
                      <span>!돈 - 은행 잔액 및 BTC 보유량 확인</span>
                      <span>!이체 [내계좌] [상대계좌] [금액] - 송금</span>
                      <span>!도박 [금액] [내계좌번호] - 베팅</span>
                    </div>
                  </div>
                  <div className="bg-amber-500/5 p-4 rounded-xl border border-amber-500/20">
                    <p className="text-[10px] uppercase text-amber-400 font-bold mb-2">⛏️ BTC 채굴 시스템</p>
                    <div className="grid grid-cols-1 gap-2 text-[11px] font-mono text-amber-300">
                      <span>!채굴 상점 - 기기 목록 및 가격 확인</span>
                      <span>!채굴 구매 [ID] [계좌] - 기기 구매</span>
                      <span>!채굴 현황 - 내 기기 및 해시레이트</span>
                      <span>!BTC 판매 [수량] [계좌] - BTC 현금화</span>
                    </div>
                  </div>
                  <div className="bg-indigo-500/5 p-4 rounded-xl border border-indigo-500/20">
                    <p className="text-[10px] uppercase text-indigo-400 font-bold mb-2">🏦 은행 & 대출</p>
                    <div className="grid grid-cols-1 gap-2 text-[11px] font-mono text-indigo-300">
                      <span>!은행 - 내 계좌 정보 및 이율 확인</span>
                      <span>!은행 가입 [1/2/3] - 계좌 개설</span>
                      <span>!은행 목록 - 전체 계좌/소유주 조회</span>
                      <span>!대출 신청 [은행] [금] [일] [입금계좌]</span>
                      <span>!대출 상환 [ID] [출금계좌] - 상환</span>
                    </div>
                  </div>
                  <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                    <p className="text-[10px] uppercase text-slate-500 font-bold mb-2">📈 주식 시스템</p>
                    <div className="grid grid-cols-1 gap-2 text-[11px] font-mono text-emerald-400">
                      <span>!주식 - 현재 시세 확인</span>
                      <span>!주식 그래프 [코드] - 시세 변동 그래프</span>
                      <span>!내주식 - 수익률 및 포트폴리오</span>
                      <span>!매수/매도 [코드] [수량] [내계좌번호]</span>
                    </div>
                  </div>
                  <div className="bg-rose-500/5 p-4 rounded-xl border border-rose-500/20">
                    <p className="text-[10px] uppercase text-rose-400 font-bold mb-2">🛡️ 관리자 전용</p>
                    <div className="grid grid-cols-1 gap-2 text-[11px] font-mono text-rose-300">
                      <span>!주식설정 [시간/범위] [값]</span>
                      <span>!주가조작 [코드] [가격]</span>
                      <span>!주식추가 [코드] [이름] [가격]</span>
                      <span>!주식제거 [코드]</span>
                      <span>!돈주기 [계좌번호] [금액]</span>
                      <span>!압류 [계좌번호] [금액]</span>
                      <span>!강제매도 [계좌번호] [코드]</span>
                    </div>
                  </div>
                  <div className="bg-slate-800/5 p-4 rounded-xl border border-slate-700/50">
                    <p className="text-[10px] uppercase text-slate-500 font-bold mb-2">📜 전체 명령어 확인</p>
                    <div className="text-[11px] font-mono text-slate-400">
                      <span>디스코드에서 <strong>!명령어</strong> 입력</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="py-6 flex flex-col items-center justify-center text-slate-500">
                  <Activity className="w-12 h-12 mb-4 opacity-20" />
                  <p className="text-sm italic">봇 연결 대기 중...</p>
                </div>
                
                <form onSubmit={handleManualLogin} className="space-y-4">
                  <div>
                    <label className="text-[10px] uppercase text-slate-500 font-bold mb-2 block">디스코드 봇 토큰 입력</label>
                    <input 
                      type="password"
                      value={manualToken}
                      onChange={(e) => setManualToken(e.target.value)}
                      placeholder="MTIzNDU2Nzg5..."
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-indigo-500 transition-colors"
                    />
                  </div>
                  {loginError && (
                    <p className="text-xs text-rose-500 bg-rose-500/10 p-2 rounded-lg border border-rose-500/20">
                      {loginError}
                    </p>
                  )}
                  <button 
                    type="submit"
                    disabled={isLoggingIn || !manualToken.trim()}
                    className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-xl font-bold text-sm transition-all shadow-lg shadow-indigo-600/20"
                  >
                    {isLoggingIn ? "연결 중..." : "봇 연결하기"}
                  </button>
                </form>
              </div>
            )}
          </motion.div>

            {/* Setup Guide */}
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="bg-indigo-600/10 border border-indigo-500/20 rounded-2xl p-6"
            >
              <div className="flex items-center gap-2 mb-4">
                <ShieldCheck className="w-5 h-5 text-indigo-400" />
                <h2 className="font-semibold text-white">설정 체크리스트</h2>
              </div>
              <ul className="space-y-3 text-sm">
                <li className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-indigo-500/20 flex items-center justify-center text-[10px] mt-0.5">1</div>
                  <span>Discord Portal에서 3가지 <strong>Privileged Gateway Intents</strong>를 활성화하세요.</span>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-indigo-500/20 flex items-center justify-center text-[10px] mt-0.5">2</div>
                  <span>아래에 <strong>Client ID</strong>를 입력해 봇을 초대하세요.</span>
                </li>
              </ul>
              
              <div className="mt-6 pt-6 border-t border-white/5 space-y-4">
                <div>
                  <label className="text-[10px] uppercase text-slate-500 font-bold mb-2 block">Bot Client ID (Application ID)</label>
                  <input 
                    type="text"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="1234567890..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-xs focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
                {clientId && (
                  <a 
                    href={generateInviteLink()}
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl transition-all text-sm font-bold shadow-lg shadow-indigo-600/20"
                  >
                    서버에 봇 초대하기 <ExternalLink className="w-4 h-4" />
                  </a>
                )}
              </div>
            </motion.div>
        </div>

        {/* Right Column: Logs & Activity */}
        <div className="lg:col-span-2 space-y-6">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex flex-col h-[600px] shadow-2xl"
          >
            <div className="px-6 py-4 border-b border-slate-800 bg-slate-900/80 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Terminal className="w-5 h-5 text-indigo-400" />
                <h2 className="font-semibold text-white">실시간 콘솔 로그</h2>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">자동 새로고침 중</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 font-mono text-sm space-y-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
              <AnimatePresence initial={false}>
                {botInfo.logs.length > 0 ? (
                  botInfo.logs.map((log, i) => (
                    <motion.div
                      key={`${i}-${log}`}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex gap-4 group"
                    >
                      <span className="text-slate-600 select-none">{log.match(/\[(.*?)\]/)?.[1] || ''}</span>
                      <span className="text-slate-300 group-hover:text-white transition-colors">
                        {log.replace(/\[(.*?)\]\s/, '')}
                      </span>
                    </motion.div>
                  ))
                ) : (
                  <div className="h-full flex items-center justify-center text-slate-600 italic">
                    아직 기록된 로그가 없습니다...
                  </div>
                )}
              </AnimatePresence>
            </div>

            <div className="px-6 py-3 bg-slate-950 border-t border-slate-800 text-[10px] text-slate-500 flex justify-between">
              <span>시스템: Node.js v20+</span>
              <span>discord.js v14.x</span>
            </div>
          </motion.div>

          {/* Quick Actions */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-slate-900/50 border border-slate-800 p-4 rounded-2xl flex items-center gap-4">
              <div className="bg-indigo-500/10 p-3 rounded-xl">
                <MessageSquare className="w-6 h-6 text-indigo-400" />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-white">명령어 테스트</h4>
                <p className="text-xs text-slate-500">디스코드에서 <code className="text-indigo-400">!ping</code> 입력</p>
              </div>
            </div>
            <div className="bg-slate-900/50 border border-slate-800 p-4 rounded-2xl flex items-center gap-4">
              <div className="bg-emerald-500/10 p-3 rounded-xl">
                <User className="w-6 h-6 text-emerald-400" />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-white">사용자 상호작용</h4>
                <p className="text-xs text-slate-500">디스코드에서 <code className="text-emerald-400">!안녕</code> 입력</p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

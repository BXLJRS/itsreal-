import React, { useState, useEffect, useRef } from 'react';
import { 
  APIProvider, 
  Map, 
  AdvancedMarker, 
  Pin,
} from '@vis.gl/react-google-maps';
import { useSocket } from './hooks/useSocket';
import { 
  Users, 
  Map as MapIcon, 
  MessageSquare, 
  Undo2, 
  MousePointer2, 
  Pencil, 
  MapPin,
  Sword,
  CheckCircle2,
  XCircle,
  Bot,
  Eraser,
  ChevronDown,
  Send,
  User,
  ArrowUpRight,
  Sparkles
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { GoogleGenAI } from "@google/genai";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---
interface DrawingAction {
  actionId: string;
  userId: string;
  type: 'line' | 'ping' | 'erase';
  payload: any;
}

interface PinData {
  id: string;
  name: string;
  lat: number;
  lng: number;
  assigned_day: number;
  time_slot?: string;
}

interface UserPresence {
  userId: string;
  nickname: string;
  avatarUrl: string;
  center: { lat: number, lng: number };
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// --- Components ---

const DrawingCanvas = ({ roomId, userId, color, thickness, tool, isActive }: { roomId: string, userId: string, color: string, thickness: number, tool: 'pencil' | 'eraser', isActive: boolean }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { on, emit } = useSocket(roomId);
  const [isDrawing, setIsDrawing] = useState(false);
  const [remoteActions, setRemoteActions] = useState<DrawingAction[]>([]);
  const lastPos = useRef<{ x: number, y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      redraw();
    };

    const redraw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      remoteActions.forEach(drawAction);
    };

    window.addEventListener('resize', resize);
    resize();

    const offSync = on('SYNC_ACTION', (action: DrawingAction) => {
      setRemoteActions(prev => [...prev, action]);
      drawAction(action);
    });

    const offUndo = on('UNDO_EXECUTE', ({ actionId }: { actionId: string }) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setRemoteActions(prev => {
        const filtered = prev.filter(a => a.actionId !== actionId);
        filtered.forEach(drawAction);
        return filtered;
      });
    });

    return () => {
      window.removeEventListener('resize', resize);
      offSync();
      offUndo();
    };
  }, [on, remoteActions]);

  const drawAction = (action: DrawingAction) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (action.type === 'line' || action.type === 'erase') {
      const { points, color, thickness } = action.payload;
      ctx.beginPath();
      ctx.globalCompositeOperation = action.type === 'erase' ? 'destination-out' : 'source-over';
      ctx.strokeStyle = color;
      ctx.lineWidth = thickness;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDrawing(true);
    lastPos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing || !lastPos.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const currentPos = { x: e.clientX, y: e.clientY };
    
    ctx.beginPath();
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = tool === 'eraser' ? 'rgba(0,0,0,1)' : color;
    ctx.lineWidth = thickness;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(currentPos.x, currentPos.y);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';

    emit('DRAW_ACTION', {
      userId,
      type: tool === 'eraser' ? 'erase' : 'line',
      payload: {
        points: [lastPos.current, currentPos],
        color: tool === 'eraser' ? 'rgba(0,0,0,1)' : color,
        thickness
      }
    });

    lastPos.current = currentPos;
  };

  const handleMouseUp = () => {
    setIsDrawing(false);
    lastPos.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      className={cn(
        "fixed inset-0 z-10",
        isActive ? "pointer-events-auto cursor-crosshair" : "pointer-events-none"
      )}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    />
  );
};

const AIChatPanel = ({ roomId, userId, pins, isOpen, onClose }: { roomId: string, userId: string, pins: any[], isOpen: boolean, onClose: () => void }) => {
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const { emit } = useSocket(roomId);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const send = async () => {
    if (!input.trim() || isThinking) return;
    const content = input;
    setMessages(prev => [...prev, { userId, content, role: 'user' }]);
    setInput('');
    setIsThinking(true);
    emit('SET_AI_STATE', { isThinking: true });

    try {
      const context = `
        현재 여행 계획 데이터: ${JSON.stringify(pins)}
        사용자 질문: ${content}
        당신은 '이거 진짜에요맵'의 여행 비서입니다. 한국어로 친절하고 유머러스하게 답변해주세요.
      `;
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: context,
      });

      const aiReply = response.text || "죄송해요, 지금은 답변하기가 어렵네요!";
      setMessages(prev => [...prev, { userId: 'AI', content: aiReply, role: 'assistant' }]);
    } catch (error) {
      console.error("AI Error:", error);
      setMessages(prev => [...prev, { userId: 'AI', content: "연결 오류가 발생했습니다.", role: 'assistant' }]);
    } finally {
      setIsThinking(false);
      emit('SET_AI_STATE', { isThinking: false });
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div 
          initial={{ x: 400, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 400, opacity: 0 }}
          className="fixed top-24 bottom-24 right-6 w-96 bg-white/80 backdrop-blur-2xl border border-white/40 rounded-[2rem] flex flex-col shadow-2xl z-[60] overflow-hidden"
        >
          <div className="p-6 border-b border-black/5 flex items-center justify-between bg-white/40">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-indigo-500 rounded-full flex items-center justify-center shadow-lg shadow-indigo-500/30">
                <Sparkles size={20} className="text-white" />
              </div>
              <div>
                <h2 className="text-black font-bold text-lg leading-tight">AI 여행 비서</h2>
                <span className="text-black/40 text-xs font-medium">실시간 계획 도우미</span>
              </div>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-black/5 rounded-full transition-colors">
              <XCircle size={20} className="text-black/20" />
            </button>
          </div>
          
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4">
            {messages.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-30">
                <Bot size={48} />
                <p className="text-sm font-medium">무엇이든 물어보세요!<br/>"내일 동선 짜줘" 혹은 "맛집 추천해줘"</p>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={cn("flex flex-col", m.role === 'user' ? "items-end" : "items-start")}>
                <div className={cn(
                  "px-4 py-3 rounded-2xl text-sm max-w-[85%] shadow-sm",
                  m.role === 'user' ? "bg-indigo-500 text-white" : "bg-white text-black border border-black/5"
                )}>
                  {m.content}
                </div>
              </div>
            ))}
            {isThinking && (
              <div className="flex items-start gap-2">
                <div className="bg-white border border-black/5 px-4 py-3 rounded-2xl shadow-sm">
                  <div className="flex gap-1">
                    <div className="w-1.5 h-1.5 bg-black/20 rounded-full animate-bounce" />
                    <div className="w-1.5 h-1.5 bg-black/20 rounded-full animate-bounce [animation-delay:0.2s]" />
                    <div className="w-1.5 h-1.5 bg-black/20 rounded-full animate-bounce [animation-delay:0.4s]" />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="p-6 bg-white/40 border-t border-black/5 flex gap-3">
            <input
              disabled={isThinking}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && send()}
              placeholder="AI에게 질문하기..."
              className="flex-1 bg-white border border-black/10 rounded-2xl px-4 py-3 text-black text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all disabled:opacity-50"
            />
            <button 
              onClick={send}
              disabled={isThinking}
              className="w-12 h-12 bg-indigo-500 text-white rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-500/30 hover:bg-indigo-600 transition-all disabled:opacity-50"
            >
              <Send size={18} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

const PlannerBoard = ({ roomId, userId, pins, trips, currentTripId, onSelectTrip }: { roomId: string, userId: string, pins: PinData[], trips: any[], currentTripId: string | null, onSelectTrip: (id: string) => void }) => {
  const { emit } = useSocket(roomId);
  const [expandedDays, setExpandedDays] = useState<Record<number, boolean>>({ 1: true });
  const [newTripTitle, setNewTripTitle] = useState('');

  const days = [1, 2, 3, 4, 5];
  const hours = Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, '0')}:00`);

  const toggleDay = (day: number) => {
    setExpandedDays(prev => ({ ...prev, [day]: !prev[day] }));
  };

  const createTrip = () => {
    if (!newTripTitle.trim()) return;
    emit('CREATE_TRIP', { title: newTripTitle });
    setNewTripTitle('');
  };

  return (
    <div className="fixed left-6 top-24 bottom-24 w-80 bg-white/80 backdrop-blur-2xl border border-white/40 rounded-[2rem] flex flex-col shadow-2xl z-40 overflow-hidden">
      <div className="p-6 border-b border-black/5 space-y-4 bg-white/40">
        <h2 className="text-black font-extrabold text-xl flex items-center gap-2 tracking-tight">
          <MapIcon size={24} className="text-indigo-500" />
          여행 저장소
        </h2>
        
        <div className="space-y-3">
          <div className="flex gap-2">
            <input 
              value={newTripTitle}
              onChange={e => setNewTripTitle(e.target.value)}
              placeholder="새 여행 제목..."
              className="flex-1 bg-white border border-black/10 rounded-xl px-3 py-2 text-xs text-black focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all"
            />
            <button 
              onClick={createTrip}
              className="px-4 py-2 bg-indigo-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-indigo-500/20 hover:bg-indigo-600 transition-all"
            >
              추가
            </button>
          </div>
          
          <div className="relative">
            <select 
              value={currentTripId || ''} 
              onChange={e => onSelectTrip(e.target.value)}
              className="w-full appearance-none bg-white border border-black/10 rounded-xl px-4 py-2.5 text-sm text-black focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all cursor-pointer"
            >
              <option value="" disabled>여행을 선택하세요...</option>
              {trips.map(t => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
            <ChevronDown size={16} className="absolute right-4 top-1/2 -translate-y-1/2 text-black/20 pointer-events-none" />
          </div>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {!currentTripId ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-4 opacity-20">
            <MapPin size={48} />
            <p className="text-sm font-medium">여행을 선택하거나 새로 만들어<br/>혼돈의 계획을 시작하세요.</p>
          </div>
        ) : (
          days.map(day => (
            <div key={day} className="border border-black/5 rounded-2xl overflow-hidden bg-white/40 shadow-sm">
              <button 
                onClick={() => toggleDay(day)}
                className="w-full p-4 flex items-center justify-between hover:bg-black/5 transition-colors"
              >
                <span className="text-black font-bold text-sm">DAY {day}</span>
                <motion.div animate={{ rotate: expandedDays[day] ? 180 : 0 }}>
                  <ChevronDown size={18} className="text-black/20" />
                </motion.div>
              </button>
              
              <AnimatePresence>
                {expandedDays[day] && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden border-t border-black/5"
                  >
                    <div className="p-2 space-y-1 bg-white/20">
                      {hours.map(hour => {
                        const pinAtHour = pins.find(p => p.assigned_day === day && p.time_slot === hour);
                        return (
                          <div key={hour} className="flex gap-3 group">
                            <span className="text-[10px] font-mono text-black/20 w-8 py-2.5">{hour}</span>
                            <div className={cn(
                              "flex-1 min-h-[44px] rounded-xl border border-dashed border-black/5 p-2.5 transition-all",
                              pinAtHour ? "bg-white border-black/5 shadow-sm border-solid" : "hover:bg-white/40"
                            )}>
                              {pinAtHour ? (
                                <div className="flex items-center justify-between">
                                  <span className="text-xs text-black font-semibold">{pinAtHour.name}</span>
                                  <div className="w-5 h-5 bg-indigo-500/10 rounded-full flex items-center justify-center">
                                    <MapPin size={10} className="text-indigo-500" />
                                  </div>
                                </div>
                              ) : (
                                <div className="h-full w-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button className="text-[10px] font-bold text-black/20 hover:text-indigo-500">
                                    + 일정 추가
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

const UserPresenceMarker = ({ user }: { user: UserPresence }) => {
  return (
    <AdvancedMarker position={user.center}>
      <div className="relative group">
        <motion.div 
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          className="flex flex-col items-center"
        >
          <div className="w-10 h-10 rounded-full border-2 border-white shadow-xl overflow-hidden bg-indigo-500">
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt={user.nickname} className="w-full h-full object-cover" />
            ) : (
              <User className="text-white p-2" />
            )}
          </div>
          <div className="mt-1 px-2 py-0.5 bg-black/80 backdrop-blur-md rounded-full text-[10px] text-white font-bold shadow-lg">
            {user.nickname}
          </div>
          {/* Stickman Body Simulation */}
          <div className="w-0.5 h-6 bg-black/80 mt-[-2px]" />
          <div className="flex gap-4 mt-[-4px]">
            <div className="w-0.5 h-4 bg-black/80 rotate-[30deg]" />
            <div className="w-0.5 h-4 bg-black/80 rotate-[-30deg]" />
          </div>
        </motion.div>
      </div>
    </AdvancedMarker>
  );
};

const OffScreenIndicator = ({ user, mapBounds }: { user: UserPresence, mapBounds: any }) => {
  if (!mapBounds) return null;
  
  const isOffScreen = !mapBounds.contains(user.center);
  if (!isOffScreen) return null;

  return (
    <div className="fixed inset-0 pointer-events-none z-[100]">
      <div className="absolute top-1/2 right-4 -translate-y-1/2 flex items-center gap-2">
        <div className="flex flex-col items-end">
          <span className="text-[10px] font-bold text-white bg-black/50 px-2 py-0.5 rounded-full">{user.nickname}</span>
          <ArrowUpRight size={16} className="text-white drop-shadow-lg" />
        </div>
        <div className="w-10 h-10 rounded-full border-2 border-white shadow-xl overflow-hidden bg-indigo-500">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt={user.nickname} className="w-full h-full object-cover" />
          ) : (
            <User className="text-white p-2" />
          )}
        </div>
      </div>
    </div>
  );
};

const BattleModal = ({ opponent, onChoice }: { opponent: string, onChoice: (choice: string) => void }) => {
  return (
    <motion.div 
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="bg-zinc-900 border border-white/10 p-8 rounded-3xl shadow-2xl text-center space-y-8 max-w-md w-full mx-4">
        <div className="space-y-2">
          <div className="flex justify-center mb-4">
            <div className="p-4 bg-red-500/20 rounded-full animate-pulse">
              <Sword size={48} className="text-red-500" />
            </div>
          </div>
          <h2 className="text-3xl font-black text-white uppercase italic tracking-tighter">Conflict!</h2>
          <p className="text-white/60">Battle with <span className="text-indigo-400 font-bold">{opponent}</span> to claim the pin!</p>
        </div>

        <div className="grid grid-cols-3 gap-4">
          {['ROCK', 'PAPER', 'SCISSORS'].map(choice => (
            <button
              key={choice}
              onClick={() => onChoice(choice)}
              className="aspect-square bg-white/5 border border-white/10 rounded-2xl flex flex-col items-center justify-center gap-2 hover:bg-indigo-500/20 hover:border-indigo-500 transition-all group"
            >
              <span className="text-2xl">{choice === 'ROCK' ? '✊' : choice === 'PAPER' ? '✋' : '✌️'}</span>
              <span className="text-[10px] font-bold text-white/40 group-hover:text-white">{choice}</span>
            </button>
          ))}
        </div>
        
        <div className="h-1 bg-white/10 rounded-full overflow-hidden">
          <motion.div 
            initial={{ width: "100%" }}
            animate={{ width: "0%" }}
            transition={{ duration: 7, ease: "linear" }}
            className="h-full bg-indigo-500"
          />
        </div>
      </div>
    </motion.div>
  );
};

const VoteModal = ({ pinName, targetDay, onVote }: { pinName: string, targetDay: number, onVote: (agree: boolean) => void }) => {
  return (
    <motion.div 
      initial={{ y: 50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="fixed bottom-32 left-1/2 -translate-x-1/2 z-[90] w-full max-w-sm px-4"
    >
      <div className="bg-zinc-900/90 backdrop-blur-xl border border-white/10 p-6 rounded-2xl shadow-2xl space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-500/20 rounded-lg flex items-center justify-center">
            <MapPin size={20} className="text-indigo-400" />
          </div>
          <div>
            <h3 className="text-white font-bold text-sm">Schedule Change Request</h3>
            <p className="text-white/50 text-xs">Move <span className="text-white">{pinName}</span> to Day {targetDay}?</p>
          </div>
        </div>

        <div className="flex gap-3">
          <button 
            onClick={() => onVote(true)}
            className="flex-1 bg-emerald-500/20 border border-emerald-500/50 text-emerald-400 py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 hover:bg-emerald-500 hover:text-white transition-all"
          >
            <CheckCircle2 size={16} /> Agree
          </button>
          <button 
            onClick={() => onVote(false)}
            className="flex-1 bg-red-500/20 border border-red-500/50 text-red-400 py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 hover:bg-red-500 hover:text-white transition-all"
          >
            <XCircle size={16} /> Disagree
          </button>
        </div>

        <div className="h-1 bg-white/10 rounded-full overflow-hidden">
          <motion.div 
            initial={{ width: "100%" }}
            animate={{ width: "0%" }}
            transition={{ duration: 15, ease: "linear" }}
            className="h-full bg-indigo-500"
          />
        </div>
      </div>
    </motion.div>
  );
};

const ProfileModal = ({ userId, roomId, onComplete }: { userId: string, roomId: string, onComplete: () => void }) => {
  const [nickname, setNickname] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const { emit } = useSocket(roomId);

  const save = () => {
    if (!nickname.trim()) return;
    emit('UPDATE_PROFILE', { roomId, userId, nickname, avatarUrl });
    onComplete();
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-md">
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-white p-8 rounded-[2.5rem] shadow-2xl max-w-sm w-full mx-4 space-y-6"
      >
        <div className="text-center space-y-2">
          <div className="w-20 h-20 bg-indigo-500 rounded-full mx-auto flex items-center justify-center shadow-xl shadow-indigo-500/20 overflow-hidden">
            {avatarUrl ? <img src={avatarUrl} className="w-full h-full object-cover" /> : <User size={40} className="text-white" />}
          </div>
          <h2 className="text-2xl font-black text-black tracking-tight">프로필 설정</h2>
          <p className="text-black/40 text-sm font-medium">지도 위에서 당신을 나타낼 정보를 입력하세요.</p>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-black/40 uppercase ml-4">닉네임</label>
            <input 
              value={nickname}
              onChange={e => setNickname(e.target.value)}
              placeholder="멋진 닉네임..."
              className="w-full bg-black/5 border-none rounded-2xl px-5 py-3.5 text-black focus:ring-2 focus:ring-indigo-500/20 transition-all"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-black/40 uppercase ml-4">아바타 URL (얼굴 사진)</label>
            <input 
              value={avatarUrl}
              onChange={e => setAvatarUrl(e.target.value)}
              placeholder="https://..."
              className="w-full bg-black/5 border-none rounded-2xl px-5 py-3.5 text-black focus:ring-2 focus:ring-indigo-500/20 transition-all"
            />
          </div>
        </div>

        <button 
          onClick={save}
          className="w-full bg-black text-white py-4 rounded-2xl font-bold hover:bg-zinc-800 transition-all shadow-xl shadow-black/10"
        >
          시작하기
        </button>
      </motion.div>
    </div>
  );
};

// --- Main App ---

export default function App() {
  const roomId = "chaos-room-1";
  const userId = useRef(`user_${Math.random().toString(36).substr(2, 5)}`).current;
  const { connected, emit, on } = useSocket(roomId);
  
  const [trips, setTrips] = useState<any[]>([]);
  const [currentTripId, setCurrentTripId] = useState<string | null>(null);
  const [pins, setPins] = useState<PinData[]>([]);
  const [otherUsers, setOtherUsers] = useState<Record<string, UserPresence>>({});
  const [showProfileModal, setShowProfileModal] = useState(true);
  const [myProfile, setMyProfile] = useState<any>(null);

  const [battle, setBattle] = useState<{ pinId: string, opponent: string } | null>(null);
  const [vote, setVote] = useState<{ pinId: string, targetDay: number, voteId: string } | null>(null);
  const [color, setColor] = useState('#6366f1');
  const [thickness, setThickness] = useState(4);
  const [tool, setTool] = useState<'pencil' | 'eraser'>('pencil');
  const [isDrawMode, setIsDrawMode] = useState(false);
  const [isAIChatOpen, setIsAIChatOpen] = useState(false);
  const [mapBounds, setMapBounds] = useState<google.maps.LatLngBounds | null>(null);

  const googleMapsApiKey = process.env.VITE_GOOGLE_MAPS_API_KEY || "";

  useEffect(() => {
    const offTrips = on('SYNC_TRIPS', (data: any[]) => {
      setTrips(data);
      if (data.length > 0 && !currentTripId) setCurrentTripId(data[0].id);
    });

    const offTripCreated = on('TRIP_CREATED', (trip: any) => {
      setTrips(prev => [...prev, trip]);
      setCurrentTripId(trip.id);
    });

    const offPins = on('SYNC_PINS', (data: PinData[]) => setPins(data));

    const offBattle = on('BATTLE_START', ({ pinId, userA, userB }: any) => {
      if (userA === userId) setBattle({ pinId, opponent: userB });
      else if (userB === userId) setBattle({ pinId, opponent: userA });
    });

    const offVote = on('START_VOTE', ({ pinId, targetDay, voteId }: any) => setVote({ pinId, targetDay, voteId }));

    const offVoteResult = on('VOTE_RESULT_SYNC', ({ success, pinId, targetDay }: any) => {
      if (success) setPins(prev => prev.map(p => p.id === pinId ? { ...p, assigned_day: targetDay } : p));
      setVote(null);
    });

    const offCursor = on('USER_CURSOR_MOVED', ({ userId: otherId, center }: any) => {
      setOtherUsers(prev => {
        const existing = prev[otherId] || { userId: otherId, nickname: otherId.slice(-4), avatarUrl: '', center: { lat: 0, lng: 0 } };
        return {
          ...prev,
          [otherId]: { ...existing, center }
        };
      });
    });

    const offProfile = on('PROFILE_UPDATED', ({ userId: updatedId, nickname, avatarUrl }: any) => {
      if (updatedId === userId) {
        setMyProfile({ nickname, avatarUrl });
      } else {
        setOtherUsers(prev => {
          const existing = prev[updatedId] || { userId: updatedId, nickname, avatarUrl, center: { lat: 0, lng: 0 } };
          return {
            ...prev,
            [updatedId]: { ...existing, nickname, avatarUrl }
          };
        });
      }
    });

    return () => {
      offTrips(); offTripCreated(); offPins(); offBattle(); offVote(); offVoteResult(); offCursor(); offProfile();
    };
  }, [on, userId, currentTripId]);

  useEffect(() => {
    if (currentTripId) emit('GET_PINS', currentTripId);
  }, [currentTripId, emit]);

  const handleRPS = (choice: string) => {
    emit('RPS_CHOICE', { battleId: 'b1', userId, choice });
    setBattle(null);
    setTimeout(() => emit('BATTLE_RESULT', { winnerId: userId, pinId: battle?.pinId }), 2000);
  };

  const handleVote = (isAgree: boolean) => {
    emit('SUBMIT_VOTE', { voteId: vote?.voteId, userId, isAgree });
    setVote(null);
    setTimeout(() => emit('VOTE_FINAL_RESULT', { success: true, pinId: vote?.pinId, targetDay: vote?.targetDay }), 3000);
  };

  return (
    <APIProvider apiKey={googleMapsApiKey}>
      <div className="relative w-full h-screen bg-zinc-50 overflow-hidden font-sans selection:bg-indigo-500/30">
        {/* Real Google Map */}
        <div className="absolute inset-0">
          <Map
            defaultCenter={{ lat: 34.6873, lng: 135.5262 }}
            defaultZoom={13}
            mapId="bf50a91342511442"
            disableDefaultUI={true}
            gestureHandling="greedy"
            className="w-full h-full"
            onBoundsChanged={e => setMapBounds(e.map.getBounds() || null)}
            onCenterChanged={e => {
              const center = e.map.getCenter();
              if (center) emit('MOVE_CURSOR', { userId, center: { lat: center.lat(), lng: center.lng() } });
            }}
          >
            {pins.map(pin => (
              <AdvancedMarker key={pin.id} position={{ lat: pin.lat, lng: pin.lng }}>
                <Pin background={'#6366f1'} borderColor={'#4338ca'} glyphColor={'#fff'} />
              </AdvancedMarker>
            ))}
            {(Object.values(otherUsers) as UserPresence[]).map(u => (
              <React.Fragment key={u.userId}>
                <UserPresenceMarker user={u} />
              </React.Fragment>
            ))}
          </Map>
        </div>

        {/* Drawing Layer */}
        <DrawingCanvas roomId={roomId} userId={userId} color={color} thickness={thickness} tool={tool} isActive={isDrawMode} />

        {/* UI Overlays */}
        <div className="relative z-20 pointer-events-none w-full h-full">
          {/* Top Bar */}
          <div className="absolute top-6 left-6 right-6 flex justify-between items-center">
            <div className="flex items-center gap-4">
              <div className="bg-white/80 backdrop-blur-2xl border border-white/40 px-5 py-2.5 rounded-2xl flex items-center gap-3 pointer-events-auto shadow-xl shadow-black/5">
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
                <span className="text-black font-extrabold tracking-tight text-sm">이거 진짜에요맵</span>
              </div>
              <button 
                onClick={() => emit('UNDO_REQUEST', { roomId })}
                className="bg-white/80 backdrop-blur-2xl border border-white/40 px-4 py-2.5 rounded-2xl text-black hover:bg-white transition-all pointer-events-auto flex items-center gap-2 shadow-xl shadow-black/5"
              >
                <Undo2 size={18} className="text-black/60" />
                <span className="text-xs font-bold">전체 실행 취소</span>
              </button>
            </div>

            <div className="flex items-center gap-3 pointer-events-auto">
              <div className="flex -space-x-3">
                {[1, 2, 3].map(i => (
                  <div key={i} className="w-10 h-10 rounded-full border-2 border-white bg-indigo-500 flex items-center justify-center text-white text-xs font-bold shadow-lg">
                    U{i}
                  </div>
                ))}
              </div>
              <button className="w-10 h-10 bg-white/80 backdrop-blur-2xl border border-white/40 rounded-2xl flex items-center justify-center text-black/40 hover:text-indigo-500 transition-all shadow-xl shadow-black/5">
                <Users size={20} />
              </button>
            </div>
          </div>

          {/* Planner Sidebar */}
          <div className="pointer-events-auto">
            <PlannerBoard 
              roomId={roomId} 
              userId={userId} 
              pins={pins} 
              trips={trips}
              currentTripId={currentTripId}
              onSelectTrip={setCurrentTripId}
            />
          </div>

          {/* AI Toggle Button */}
          <div className="absolute top-6 right-48 pointer-events-auto">
            <button 
              onClick={() => setIsAIChatOpen(!isAIChatOpen)}
              className={cn(
                "px-5 py-2.5 rounded-2xl flex items-center gap-2 font-bold text-sm transition-all shadow-xl",
                isAIChatOpen ? "bg-indigo-500 text-white" : "bg-white/80 backdrop-blur-2xl border border-white/40 text-black"
              )}
            >
              <Sparkles size={18} />
              AI 비서
            </button>
          </div>

          {/* AI Chat Panel */}
          <div className="pointer-events-auto">
            <AIChatPanel roomId={roomId} userId={userId} pins={pins} isOpen={isAIChatOpen} onClose={() => setIsAIChatOpen(false)} />
          </div>

          {/* Drawing Toolbar */}
          <AnimatePresence>
            {isDrawMode && (
              <motion.div 
                initial={{ y: 100, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 100, opacity: 0 }}
                className="absolute bottom-24 left-1/2 -translate-x-1/2 bg-white/80 backdrop-blur-2xl border border-white/40 p-4 rounded-3xl flex items-center gap-6 shadow-2xl pointer-events-auto"
              >
                <div className="flex gap-2">
                  {['#6366f1', '#ef4444', '#10b981', '#f59e0b', '#000000'].map(c => (
                    <button 
                      key={c}
                      onClick={() => { setColor(c); setTool('pencil'); }}
                      className={cn(
                        "w-8 h-8 rounded-full border-2 transition-all",
                        color === c && tool === 'pencil' ? "border-black scale-110 shadow-lg" : "border-transparent"
                      )}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                <div className="w-px h-8 bg-black/5" />
                <div className="flex gap-2">
                  {[2, 4, 8, 12].map(t => (
                    <button 
                      key={t}
                      onClick={() => setThickness(t)}
                      className={cn(
                        "w-8 h-8 rounded-lg border flex items-center justify-center transition-all",
                        thickness === t ? "bg-black text-white border-black" : "bg-white/50 border-black/5 text-black/40"
                      )}
                    >
                      <div className="bg-current rounded-full" style={{ width: t, height: t }} />
                    </button>
                  ))}
                </div>
                <div className="w-px h-8 bg-black/5" />
                <button 
                  onClick={() => setTool('eraser')}
                  className={cn(
                    "w-10 h-10 rounded-xl flex items-center justify-center transition-all",
                    tool === 'eraser' ? "bg-black text-white" : "bg-white/50 text-black/40"
                  )}
                >
                  <Eraser size={20} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Floating Action Buttons */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-4 pointer-events-auto">
            <button 
              onClick={() => setIsDrawMode(!isDrawMode)}
              className={cn(
                "w-14 h-14 rounded-2xl shadow-2xl flex items-center justify-center hover:scale-110 transition-all",
                isDrawMode ? "bg-black text-white" : "bg-white/80 backdrop-blur-2xl border border-white/40 text-black"
              )}
            >
              <Pencil size={24} />
            </button>
            <button className="w-14 h-14 bg-white/80 backdrop-blur-2xl border border-white/40 text-black rounded-2xl shadow-2xl flex items-center justify-center hover:scale-110 transition-transform">
              <MapPin size={24} />
            </button>
          </div>
        </div>

        {/* Off-screen Indicators */}
        {(Object.values(otherUsers) as UserPresence[]).map(u => (
          <React.Fragment key={u.userId}>
            <OffScreenIndicator user={u} mapBounds={mapBounds} />
          </React.Fragment>
        ))}

        {/* Modals */}
        <AnimatePresence>
          {showProfileModal && <ProfileModal userId={userId} roomId={roomId} onComplete={() => setShowProfileModal(false)} />}
          {battle && <BattleModal opponent={battle.opponent} onChoice={handleRPS} />}
          {vote && <VoteModal pinName={pins.find(p => p.id === vote.pinId)?.name || "장소"} targetDay={vote.targetDay} onVote={handleVote} />}
        </AnimatePresence>

        {/* Connection Status Toast */}
        {!connected && (
          <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-red-500 text-white px-4 py-2 rounded-full text-[10px] font-bold z-[200] shadow-xl uppercase tracking-widest">
            서버 연결 끊김. 재연결 중...
          </div>
        )}
      </div>
    </APIProvider>
  );
}

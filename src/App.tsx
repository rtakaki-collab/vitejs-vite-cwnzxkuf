import { useState, useMemo, useEffect, useRef, Fragment } from 'react';
import type { FormEvent, ChangeEvent } from 'react';
import { 
  ClipboardCheck, History, LayoutDashboard, ChevronRight, ArrowLeft, Search, 
  Sparkles, Loader2, X, Hash, FileUp, Box, Plus, ListChecks, CheckCircle2, ChevronDown, ChevronUp, Save
} from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, getDoc, onSnapshot, addDoc, serverTimestamp, Timestamp } from 'firebase/firestore';

interface Equipment {
  id: string; name: string; adminId: string; model: string; location: string;
  inspectDataRaw: string; inspectors: string[]; category: string; status: 'healthy' | 'warning' | 'alert';
}

interface HistoryLog {
  id: string; eqName: string; adminId: string; inspector: string; inspectType: string;
  date: string; result: string; itemResults?: Record<string, string>; comments: string; timestamp: Timestamp | null;
}

const firebaseConfig = {
  apiKey: "AIzaSyC1NzDA8XU9254jXHgfvldO0gXx7zM8B88",
  authDomain: "test-f8dcd.firebaseapp.com",
  projectId: "test-f8dcd",
  storageBucket: "test-f8dcd.firebasestorage.app",
  messagingSenderId: "872641745489",
  appId: "1:872641745489:web:0dafcb92e43d7aea7ade70"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = 'factory-inspector-shared';
const apiKey = ""; 

const sendWebhook = async (logData: Omit<HistoryLog, 'id'>) => {
  const itemResults = logData.itemResults || {};
  const needsNotification = Object.values(itemResults).some(r => r === '要観察' || r === '不良') || (logData.comments && logData.comments.trim() !== '');
  if (!needsNotification) return;

  const issues = Object.entries(itemResults).filter(([_, result]) => result === '要観察' || result === '不良').map(([item, result]) => `・${item}：${result}`).join('\n');
  let text = `【設備・機器 点検 通知】\n設備名：${logData.eqName} (ID: ${logData.adminId})\n点検種類：${logData.inspectType}\n担当者：${logData.inspector}\n`;
  if (issues) text += `\n⚠️ 以下の項目で指摘があります:\n${issues}\n`;
  if (logData.comments) text += `\n💬 コメント:\n${logData.comments}\n`;

  try {
    await fetch("https://chat.googleapis.com/v1/spaces/AAAAtR469pk/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=KTOclU2CfEWVe-K5GmtoXS02oX0ds-0X-kFMjv42XSQ", {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text })
    });
  } catch (error) { console.error("Webhook Error", error); }
};

const callGemini = async (prompt: string) => {
  if (!apiKey) return "APIキー未設定";
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "回答を取得できませんでした。";
  } catch { return "AI取得失敗"; }
};

const parseInspectionData = (dataStr: string) => {
  if (!dataStr) return { "基本点検": ["外観確認"] };
  const res: Record<string, string[]> = {};
  dataStr.split("#").forEach(sec => {
    const parts = sec.split("=");
    if (parts.length === 2) res[parts[0].trim()] = parts[1].trim().replace(/[{}]/g, "").split("|").map(i => i.trim());
  });
  return Object.keys(res).length ? res : { "基本点検": ["外観確認"] };
};

const parseCSVRow = (str: string) => {
  const res: string[] = [];
  let inQ = false, cur = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) { res.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  res.push(cur.trim());
  return res.map(v => v.replace(/^"|"$/g, ''));
};

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [view, setView] = useState('dashboard');
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [history, setHistory] = useState<HistoryLog[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  
  const [aiLoading, setAiLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [modalContent, setModalContent] = useState({ title: "", text: "", type: "info" });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedEqName, setSelectedEqName] = useState("");
  const [selectedAdminId, setSelectedAdminId] = useState("");
  const [selectedInspectType, setSelectedInspectType] = useState("");
  const [aiAdvice, setAiAdvice] = useState("");
  const [inspectItemResults, setInspectItemResults] = useState<Record<string, string>>({});
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [historyEqFilter, setHistoryEqFilter] = useState('All');
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  useEffect(() => {
    signInAnonymously(auth).catch(console.error);
    return onAuthStateChanged(auth, setUser);
  }, []);

  useEffect(() => {
    if (!user) return;
    const unsubEq = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'equipment'), (snap) => setEquipment(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))));
    const unsubHist = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'history'), (snap) => {
      const hd = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
      hd.sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));
      setHistory(hd);
    });
    return () => { unsubEq(); unsubHist(); };
  }, [user]);

  const availableMachines = useMemo(() => equipment.filter(eq => eq.name === selectedEqName), [equipment, selectedEqName]);
  const selectedMachine = useMemo(() => availableMachines.find(m => m.adminId === selectedAdminId) || availableMachines[0], [availableMachines, selectedAdminId]);
  const parsedInspectData = useMemo(() => selectedMachine ? parseInspectionData(selectedMachine.inspectDataRaw) : {}, [selectedMachine]);
  const currentChecklist = useMemo(() => parsedInspectData[selectedInspectType] || [], [parsedInspectData, selectedInspectType]);

  useEffect(() => { setInspectItemResults({}); }, [currentChecklist, selectedAdminId]);
  useEffect(() => { if (availableMachines.length > 0 && !availableMachines.find(m => m.adminId === selectedAdminId)) setSelectedAdminId(availableMachines[0].adminId); }, [availableMachines, selectedAdminId]);
  useEffect(() => { if (selectedMachine && !Object.keys(parsedInspectData).includes(selectedInspectType)) setSelectedInspectType(Object.keys(parsedInspectData)[0] || ""); }, [selectedMachine, parsedInspectData, selectedInspectType]);

  const uniqueEqNames = useMemo(() => Array.from(new Set(equipment.map(eq => eq.name))), [equipment]);
  const categories = useMemo(() => ['All', ...Array.from(new Set(equipment.map(eq => eq.category || '未分類')))], [equipment]);
  const uniqueHistEqs = useMemo(() => Array.from(new Set(history.map(h => h.eqName))), [history]);
  const filteredHistory = useMemo(() => history.filter(h => historyEqFilter === 'All' || h.eqName === historyEqFilter), [history, historyEqFilter]);

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAiLoading(true);
    const processCSV = async () => {
      try {
        const text = await new Promise<string>((res) => { const r = new FileReader(); r.onload = (ev) => res(ev.target?.result as string); r.readAsText(file, 'UTF-8'); });
        const lines = text.trim().split(/\r?\n/);
        const headers = parseCSVRow(lines[0] || "");
        const idx = {
          name: headers.findIndex(h => /名前|設備|機器/.test(h)), model: headers.findIndex(h => /型式/.test(h)),
          id: headers.findIndex(h => /管理/.test(h)), branch: headers.findIndex(h => /枝番/.test(h)),
          loc: headers.findIndex(h => /場所/.test(h)), ins: headers.findIndex(h => /点検者|担当/.test(h)),
          data: headers.findIndex(h => /種類|項目/.test(h)), cat: headers.findIndex(h => /カテゴリ|分類/.test(h))
        };
        for (let i = 1; i < lines.length; i++) {
          const parts = parseCSVRow(lines[i]);
          const name = idx.name >= 0 ? parts[idx.name] : "", idBase = idx.id >= 0 ? parts[idx.id] : "";
          if (!name || !idBase) continue;
          const branch = idx.branch >= 0 ? parts[idx.branch] : "";
          const uid = branch ? `${idBase.trim()}-${branch.trim()}` : idBase.trim();
          const dRef = doc(db, 'artifacts', appId, 'public', 'data', 'equipment', uid);
          const snap = await getDoc(dRef);
          await setDoc(dRef, {
            name: name.trim(), adminId: uid, model: idx.model >= 0 ? parts[idx.model] : "",
            location: idx.loc >= 0 ? parts[idx.loc] : "未登録", inspectDataRaw: idx.data >= 0 ? parts[idx.data] : "",
            inspectors: (idx.ins >= 0 && parts[idx.ins]) ? parts[idx.ins].split("|").map(s => s.trim()) : ["未登録"],
            category: idx.cat >= 0 ? parts[idx.cat] : "未分類", status: snap.exists() ? (snap.data()?.status || 'healthy') : 'healthy'
          });
        }
        setModalContent({ title: "成功", text: "データを保存しました", type: "success" }); setShowModal(true);
      } catch {
        setModalContent({ title: "エラー", text: "失敗しました", type: "error" }); setShowModal(true);
      }
      setAiLoading(false); if (fileInputRef.current) fileInputRef.current.value = "";
    };
    processCSV();
  };

  const isAllChecked = currentChecklist.length > 0 && currentChecklist.every(item => inspectItemResults[item]);

  const handleInspectionSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user || !selectedMachine || !isAllChecked) return;
    setAiLoading(true);
    const fd = new FormData(e.currentTarget);
    const comments = fd.get('comments') as string;
    const resArr = Object.values(inspectItemResults);
    let overall = '良・完了';
    if (resArr.includes('不良')) overall = '不良'; else if (resArr.includes('要観察')) overall = '要観察';

    const logData: Omit<HistoryLog, 'id'> = {
      eqName: selectedMachine.name, adminId: selectedMachine.adminId, inspector: fd.get('inspector') as string,
      inspectType: fd.get('inspectType') as string, date: new Date().toLocaleDateString('ja-JP'),
      result: overall, itemResults: inspectItemResults, comments, timestamp: serverTimestamp() as Timestamp
    };

    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'history'), logData);
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'equipment', selectedMachine.adminId), {
        ...selectedMachine, status: overall === '良・完了' ? 'healthy' : (overall === '要観察' ? 'warning' : 'alert')
      });
      await sendWebhook(logData);
      setShowCompleteModal(true);
    } catch {
      setModalContent({ title: "エラー", text: "保存失敗", type: "error" }); setShowModal(true);
    }
    setAiLoading(false);
  };

  const stats = useMemo(() => ({
    t: equipment.length, h: equipment.filter(e => e.status === 'healthy').length,
    w: equipment.filter(e => e.status === 'warning').length, a: equipment.filter(e => e.status === 'alert').length,
  }), [equipment]);

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 flex">
      {/* Sidebar */}
      <div className="fixed inset-y-0 left-0 w-64 bg-slate-900 text-white p-6 hidden md:flex flex-col z-40 shadow-2xl">
        <div className="flex items-center gap-3 mb-10"><div className="bg-indigo-600 p-2.5 rounded-xl"><ClipboardCheck size={26} /></div><h1 className="font-black text-xl">設備・機器 点検</h1></div>
        <nav className="space-y-1.5 flex-1">
          {[ {id:'dashboard',icon:LayoutDashboard,l:'ダッシュボード'}, {id:'list',icon:ListChecks,l:'設備点検'}, {id:'history',icon:History,l:'履歴管理'}, {id:'import',icon:FileUp,l:'CSV同期'} ].map(n => (
            <button key={n.id} onClick={()=>setView(n.id)} className={`w-full flex items-center gap-4 px-5 py-4 rounded-2xl transition-all ${view===n.id?'bg-indigo-600 text-white':'text-slate-400 hover:bg-slate-800'}`}><n.icon size={20}/><span className="font-bold">{n.l}</span></button>
          ))}
        </nav>
      </div>

      <main className="flex-1 md:ml-64 p-5 md:p-10 pb-24 text-left">
        {view === 'dashboard' && (
          <div className="space-y-8 max-w-6xl mx-auto animate-in fade-in">
            <h2 className="text-3xl font-black text-slate-800">工場ステータス</h2>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
              {[ {l:'総機器数',v:stats.t,c:'bg-white text-slate-900'},{l:'正常',v:stats.h,c:'bg-green-500 text-white'},{l:'要注意',v:stats.w,c:'bg-amber-500 text-white'},{l:'異常',v:stats.a,c:'bg-rose-500 text-white'} ].map((s,i)=>(
                <div key={i} className={`${s.c} p-6 rounded-[2rem] shadow-sm flex flex-col justify-between h-36`}><span className="text-xs font-bold opacity-80 uppercase">{s.l}</span><div className="text-5xl font-black">{s.v}</div></div>
              ))}
            </div>
          </div>
        )}

        {view === 'list' && (
          <div className="space-y-6 max-w-6xl mx-auto animate-in fade-in">
            <div className="flex flex-col md:flex-row justify-between md:items-end gap-4"><h2 className="text-3xl font-black text-slate-800">点検対象選択</h2><div className="relative w-full md:w-80"><Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" size={20} /><input type="text" placeholder="設備名検索..." className="w-full pl-12 pr-6 py-3 rounded-2xl border outline-none" value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} /></div></div>
            <div className="flex gap-2 overflow-x-auto pb-2">{categories.map(c => <button key={c} onClick={()=>setSelectedCategory(c)} className={`px-5 py-2 rounded-full text-xs font-bold border ${selectedCategory===c?'bg-slate-800 text-white':'bg-white text-slate-500'}`}>{c}</button>)}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {uniqueEqNames.filter(n=>n.toLowerCase().includes(searchQuery.toLowerCase())).map(name=>(
                <button key={name} onClick={()=>{setSelectedEqName(name); setView('inspect');}} className="bg-white p-6 rounded-[2rem] border flex items-center justify-between hover:border-indigo-400 group shadow-sm"><div className="flex items-center gap-5"><div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-indigo-50 text-indigo-600"><Box size={24}/></div><div className="font-black text-xl">{name}</div></div><ChevronRight className="text-slate-200 group-hover:text-indigo-600" /></button>
              ))}
            </div>
          </div>
        )}

        {view === 'inspect' && selectedMachine && (
          <div className="max-w-3xl mx-auto space-y-6 animate-in fade-in">
             <button onClick={()=>setView('list')} className="flex items-center gap-2 text-slate-400 hover:text-slate-800 font-bold"><ArrowLeft size={18}/> 一覧に戻る</button>
             <div className="bg-white p-8 md:p-12 rounded-[3rem] shadow-2xl border">
              <div className="flex justify-between items-start mb-10"><h2 className="text-4xl font-black">{selectedEqName}</h2><button onClick={async()=>{setAiLoading(true); setAiAdvice(await callGemini(`${selectedMachine.name}の点検アドバイスを。`)); setAiLoading(false);}} disabled={aiLoading} className="bg-amber-50 text-amber-700 p-3 rounded-2xl font-bold flex gap-2 border text-sm"><Sparkles size={18}/> AI助言</button></div>
              {aiAdvice && <div className="mb-8 bg-amber-50 p-6 rounded-3xl border text-amber-900 text-sm whitespace-pre-wrap">{aiAdvice}</div>}
              
              <form ref={formRef} onSubmit={handleInspectionSubmit} className="space-y-10">
                <div className="bg-slate-50 p-6 rounded-[2rem] border space-y-4"><label className="text-xs font-black uppercase text-indigo-600 flex items-center gap-2"><Hash size={16}/> 管理番号</label><select value={selectedAdminId} onChange={e=>setSelectedAdminId(e.target.value)} className="w-full p-4 rounded-2xl border-2 font-black text-lg bg-white outline-none">{availableMachines.map(m=><option key={m.adminId} value={m.adminId}>{m.adminId}</option>)}</select></div>
                <div className="grid grid-cols-2 gap-4"><div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-400">種類</label><select name="inspectType" required value={selectedInspectType} onChange={e=>setSelectedInspectType(e.target.value)} className="w-full p-4 rounded-2xl border-2 bg-slate-50 font-bold outline-none">{Object.keys(parsedInspectData).map(t=><option key={t} value={t}>{t}</option>)}</select></div><div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-400">担当</label><select name="inspector" required className="w-full p-4 rounded-2xl border-2 bg-slate-50 font-bold outline-none">{selectedMachine.inspectors?.map(i=><option key={i} value={i}>{i}</option>)}</select></div></div>
                <div className="space-y-4"><label className="text-xs font-black uppercase text-indigo-600">各項目の判定</label>
                  <div className="flex flex-col gap-4">{currentChecklist.map((item, i) => (
                    <div key={i} className="p-5 bg-white border-2 rounded-2xl"><div className="font-bold mb-3">{item}</div><div className="grid grid-cols-3 gap-2">{['良・完了','要観察','不良'].map(r=>{
                      const sel = inspectItemResults[item] === r;
                      return <button type="button" key={r} onClick={()=>setInspectItemResults(p=>({...p,[item]:r}))} className={`py-3 text-sm font-black rounded-xl border-2 ${sel?(r==='良・完了'?'bg-green-50 border-green-500 text-green-700':r==='要観察'?'bg-amber-50 border-amber-500 text-amber-700':'bg-rose-50 border-rose-500 text-rose-700'):'bg-slate-50 text-slate-400'}`}>{r}</button>
                    })}</div></div>
                  ))}</div>
                </div>
                <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-400">コメント</label><textarea name="comments" rows={3} className="w-full p-5 rounded-2xl border-2 outline-none font-medium bg-slate-50"></textarea></div>
                <button type="submit" disabled={aiLoading || !isAllChecked} className={`w-full text-white py-6 rounded-3xl font-black shadow-2xl flex items-center justify-center gap-3 text-xl ${isAllChecked?'bg-indigo-600 hover:bg-indigo-700':'bg-slate-300'}`}>{aiLoading ? <Loader2 className="animate-spin" /> : <Save />} {isAllChecked ? '点検完了' : '全項目を判定してください'}</button>
              </form>
             </div>
          </div>
        )}

        {view === 'import' && (
          <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in text-center">
            <h2 className="text-3xl font-black text-slate-800">CSV同期</h2>
            <div className="bg-white p-16 rounded-[3rem] shadow-sm border space-y-8"><div className="bg-indigo-50 p-6 rounded-full text-indigo-600 w-fit mx-auto"><FileUp size={48}/></div><h3 className="text-2xl font-black text-slate-800">ファイルアップロード</h3><label className="block cursor-pointer bg-indigo-600 hover:bg-indigo-700 text-white py-5 px-10 rounded-2xl font-black w-fit mx-auto shadow-xl"><Plus size={24} className="inline mr-2"/>選択<input type="file" ref={fileInputRef} accept=".csv" onChange={handleFileUpload} className="hidden"/></label></div>
          </div>
        )}

        {view === 'history' && (
          <div className="space-y-6 max-w-6xl mx-auto animate-in fade-in">
            <div className="flex flex-col md:flex-row justify-between gap-4"><h2 className="text-3xl font-black text-slate-800">点検履歴</h2><select value={historyEqFilter} onChange={e=>setHistoryEqFilter(e.target.value)} className="p-3 rounded-xl border font-bold bg-white outline-none w-full md:w-64"><option value="All">すべて</option>{uniqueHistEqs.map(eq=><option key={eq} value={eq}>{eq}</option>)}</select></div>
            <div className="bg-white rounded-[2.5rem] shadow-sm border overflow-hidden"><table className="w-full text-left"><thead><tr className="bg-slate-50 text-slate-400 text-[10px] font-black uppercase border-b"><th className="px-6 py-6">日時</th><th className="px-6 py-6">設備名</th><th className="px-6 py-6">担当</th><th className="px-6 py-6">判定</th><th className="px-6 py-6">詳細</th></tr></thead><tbody className="divide-y">{filteredHistory.map(log=>(<Fragment key={log.id}><tr onClick={()=>setExpandedLogId(p=>p===log.id?null:log.id)} className="cursor-pointer hover:bg-slate-50"><td className="px-6 py-6 text-sm font-mono text-slate-500">{log.date}</td><td className="px-6 py-6 font-bold">{log.eqName}<div className="text-[10px] text-indigo-500">#{log.adminId}</div></td><td className="px-6 py-6 font-bold text-sm text-slate-600">{log.inspectType}<br/><span className="text-[10px]">{log.inspector}</span></td><td className="px-6 py-6"><span className={`px-4 py-1.5 rounded-full text-[10px] font-black ${log.result==='良・完了'?'bg-green-100 text-green-700':log.result==='要観察'?'bg-amber-100 text-amber-700':'bg-rose-100 text-rose-700'}`}>{log.result}</span></td><td className="px-6 py-6 text-slate-300">{expandedLogId===log.id?<ChevronUp/>:<ChevronDown/>}</td></tr>
            {expandedLogId===log.id && <tr><td colSpan={5} className="px-6 pb-8"><div className="p-5 bg-white rounded-[2rem] border shadow-sm"><div className="grid grid-cols-1 md:grid-cols-2 gap-3">{log.itemResults&&Object.entries(log.itemResults).map(([i,r])=><div key={i} className="flex justify-between bg-slate-50 p-3 rounded-xl border"><span className="text-sm font-bold">{i}</span><span className={`px-3 py-1 rounded-lg text-[10px] font-black ${r==='良・完了'?'bg-green-100 text-green-700':r==='要観察'?'bg-amber-100 text-amber-700':'bg-rose-100 text-rose-700'}`}>{r}</span></div>)}</div>{log.comments&&<div className="mt-4 p-4 bg-slate-50 rounded-xl text-sm border">{log.comments}</div>}</div></td></tr>}
            </Fragment>))}</tbody></table>{filteredHistory.length===0&&<div className="p-20 text-center font-bold text-slate-400">記録なし</div>}</div>
          </div>
        )}
      </main>

      {showModal && <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-xl z-50 flex items-center justify-center p-6"><div className="bg-white w-full max-w-2xl rounded-[3rem] shadow-2xl p-10"><h3 className="font-black text-2xl mb-6">{modalContent.title}</h3><p className="font-bold mb-8">{modalContent.text}</p><button onClick={()=>setShowModal(false)} className="bg-slate-900 text-white px-10 py-4 rounded-2xl font-black w-full">確認</button></div></div>}
      
      {showCompleteModal && <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-xl z-50 flex items-center justify-center p-6 text-center"><div className="bg-white w-full max-w-md rounded-[3rem] shadow-2xl p-10"><CheckCircle2 size={48} className="text-green-500 mx-auto mb-4" /><h3 className="text-2xl font-black mb-6">点検完了</h3><div className="space-y-3"><button onClick={()=>{setShowCompleteModal(false); setInspectItemResults({}); formRef.current?.reset();}} className="w-full bg-indigo-50 text-indigo-600 py-4 rounded-2xl font-black">続けて点検する</button><button onClick={()=>{setShowCompleteModal(false); setInspectItemResults({}); setView('list');}} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black">一覧へ戻る</button></div></div></div>}

      {/* スマホ用ボトムナビゲーション */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 flex justify-around z-40 shadow-[0_-10px_40px_rgba(0,0,0,0.05)] pb-[env(safe-area-inset-bottom)]">
        <button onClick={()=>setView('dashboard')} className={`flex flex-col items-center flex-1 py-3 ${view === 'dashboard' ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}><LayoutDashboard size={24} /><span className="text-[10px] font-black mt-1">ホーム</span></button>
        <button onClick={()=>setView('list')} className={`flex flex-col items-center flex-1 py-3 ${view === 'list' ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}><ListChecks size={24} /><span className="text-[10px] font-black mt-1">設備点検</span></button>
        <button onClick={()=>setView('history')} className={`flex flex-col items-center flex-1 py-3 ${view === 'history' ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}><History size={24} /><span className="text-[10px] font-black mt-1">履歴</span></button>
        <button onClick={()=>setView('import')} className={`flex flex-col items-center flex-1 py-3 ${view === 'import' ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}><FileUp size={24} /><span className="text-[10px] font-black mt-1">CSV同期</span></button>
      </div>
    </div>
  );
}

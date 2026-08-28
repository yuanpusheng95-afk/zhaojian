import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Project, type TurnDetail, type TurnSummary, type User } from "./api";

type ChatMessage = { id: string; side: "left" | "right"; content: string; time: string };

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
function relativeLabel(iso: string) {
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 60 * 1000) return "刚刚";
  if (delta < 60 * 60 * 1000) return `${Math.floor(delta / 60000)}分钟前`;
  if (delta < 24 * 60 * 60 * 1000) return `${Math.floor(delta / 3600000)}小时前`;
  return `${Math.floor(delta / 86400000)}天前`;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [turns, setTurns] = useState<TurnSummary[]>([]);
  const [turn, setTurn] = useState<TurnDetail | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([{
    id: "welcome", side: "left",
    content: "你好！我是你的 AI 摄影师 📸\n上传一张照片，告诉我想要的风格、场景和氛围，我来帮你生成。",
    time: timeLabel(new Date().toISOString()),
  }]);
  const [message, setMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const turnRef = useRef<TurnDetail | null>(null);
  useEffect(() => { turnRef.current = turn; }, [turn]);

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    api.projects().then((items) => {
      setProjects(items);
      setProject(items[0] ?? null);
    }).catch(() => setProjects([]));
  }, [user]);

  useEffect(() => {
    if (!project) { setTurns([]); setTurn(null); return; }
    let cancelled = false;
    api.turns(project.id).then((items) => {
      if (cancelled) return;
      setTurns(items);
      const active = project.runningTurnId ?? items[0]?.turnId;
      if (active) api.turn(project.id, active).then((detail) => !cancelled && setTurn(detail)).catch(() => undefined);
    }).catch(() => setTurns([]));
    return () => { cancelled = true; };
  }, [project]);

  const candidates = useMemo(
    () => turn?.generations.flatMap((generation) => generation.candidate ? [{ ...generation, candidate: generation.candidate }] : []) ?? [],
    [turn],
  );
  const selected = candidates.find((generation) => generation.selectedCandidateId);
  const latest = selected ?? candidates.at(-1);
  const isGenerating = turn?.status === "queued" || turn?.status === "running";

  const refreshTurns = useCallback(async (target: Project) => {
    const [items, activeId] = await Promise.all([
      api.turns(target.id),
      Promise.resolve(target.runningTurnId),
    ]);
    setTurns(items);
    const active = activeId ?? items[0]?.turnId;
    if (active) setTurn(await api.turn(target.id, active));
  }, []);

  const submit = useCallback(async () => {
    if (!message.trim() || busy) return;
    if (!project && !file) {
      setError("当前中转站只支持图生图：请先上传一张基准照片，再输入修改指令。");
      return;
    }
    setBusy(true);
    setError("");
    const now = timeLabel(new Date().toISOString());
    const sent: ChatMessage = { id: crypto.randomUUID(), side: "right", content: message, time: now };
    setChat((current) => [...current, sent, {
      id: `${sent.id}-ack`, side: "left",
      content: file ? "收到，我会基于这张照片开始拍摄。" : "收到，我马上开始生成。", time: now,
    }]);
    try {
      let currentProject = project;
      if (!currentProject) {
        let anchor;
        if (file) {
          const uploaded = await api.upload(file);
          anchor = { assetId: uploaded.assetId, uri: uploaded.uri, metadata: uploaded.metadata };
        }
        currentProject = await api.createProject({
          name: message.slice(0, 48),
          ...(anchor ? { anchorAsset: anchor } : {}),
        });
        setProject(currentProject);
        setProjects((current) => [currentProject!, ...current]);
      }
      const created = await api.sendMessage(currentProject.id, message);
      setTurn(await api.turn(currentProject.id, created.turnId));
      setMessage("");
      setFile(null);
      setPreviewUrl(null);
      setProjects(await api.projects());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  }, [busy, file, message, project]);

  useEffect(() => {
    if (!project || !turn || !isGenerating) return;
    const source = new EventSource(`/projects/${project.id}/turns/${turn.turnId}/events`);
    source.addEventListener("turn", (event) => {
      setTurn(JSON.parse((event as MessageEvent).data));
    });
    source.addEventListener("done", () => {
      const finalTurn = turnRef.current;
      const succeeded = finalTurn && finalTurn.generations.some((generation) => generation.candidate);
      const noImageOnly = !succeeded && finalTurn?.error?.code === "NO_IMAGE_GENERATED";
      setChat((current) => [...current, {
        id: crypto.randomUUID(), side: "left",
        content: succeeded
          ? "照片已经生成好了，你可以继续告诉我要怎么调整。"
          : noImageOnly
            ? "生成失败：中转站当前不支持纯文字生图，请上传一张基准照片后重试。"
            : "这次没有生成出照片，请换个描述或重新试试。",
        time: timeLabel(new Date().toISOString()),
      }]);
      source.close();
    });
    source.addEventListener("error", () => source.close());
    return () => source.close();
  }, [isGenerating, project?.id, turn?.turnId]);

  const select = useCallback(async (generationId: string, candidateId: string) => {
    if (!project || !turn) return;
    await api.select(project.id, turn.turnId, generationId, candidateId);
    setTurn(await api.turn(project.id, turn.turnId));
  }, [project, turn]);

  if (loading) {
    return <div className="grid min-h-screen place-items-center text-sm text-slate-500">加载中…</div>;
  }
  if (!user) return <AuthScreen onAuthenticated={setUser} />;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1500px] items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-500 text-white">📷</div>
            <div>
              <div className="font-semibold">AI 摄影师</div>
              <div className="text-xs text-slate-500">让每个人都有自己的摄影师</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">VIP 会员</div>
            <div className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">1200 积分</div>
            <div className="flex items-center gap-2">
              <Avatar name={user.displayName || user.email} />
              <span className="max-w-32 truncate text-sm">{user.displayName || user.email}</span>
            </div>
            <button className="text-sm text-slate-500 hover:text-slate-800" onClick={async () => { await api.logout(); setUser(null); }}>退出</button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1500px] gap-5 px-6 py-5 lg:grid-cols-[280px_minmax(0,1fr)_430px]">
        <aside className="space-y-4">
          <button
            className="w-full rounded-2xl bg-gradient-to-r from-violet-500 to-indigo-500 py-3 font-medium text-white shadow-lg shadow-violet-500/20"
            onClick={() => { setProject(null); setTurn(null); setTurns([]); setMessage(""); setFile(null); setPreviewUrl(null); setChat([{
              id: "welcome", side: "left",
              content: "开始一个新项目吧！上传照片并告诉我你想要的风格。", time: timeLabel(new Date().toISOString()),
            }]); }}
          >＋ 新建项目</button>

          <div className="rounded-2xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <span className="text-sm font-semibold">对话历史</span>
              <span className="text-xs text-slate-400">{project ? `${turns.length} 条` : ""}</span>
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto p-2">
              {turns.map((item) => (
                <button
                  key={item.turnId}
                  className={`w-full rounded-xl px-3 py-2 text-left ${turn?.turnId === item.turnId ? "bg-violet-50 text-violet-700" : "hover:bg-slate-50"}`}
                  onClick={async () => setTurn(await api.turn(project!.id, item.turnId))}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm">{item.userMessage}</span>
                    {item.status !== "completed" && <StatusDot status={item.status} />}
                  </div>
                  <div className="text-xs text-slate-400">{relativeLabel(item.updatedAt)}</div>
                </button>
              ))}
              {turns.length === 0 && <div className="px-3 py-6 text-center text-xs text-slate-400">暂无对话</div>}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">我的项目</span>
              <span className="text-xs text-slate-400">{projects.length}</span>
            </div>
            <div className="mt-3 space-y-1">
              {projects.map((item) => (
                <button
                  key={item.id}
                  className={`w-full rounded-xl px-3 py-2 text-left ${project?.id === item.id ? "bg-violet-50 text-violet-700" : "hover:bg-slate-50"}`}
                  onClick={() => setProject(item)}
                >
                  <div className="truncate text-sm">{item.name}</div>
                  <div className="text-xs text-slate-400">{relativeLabel(item.updatedAt)}{item.runningTurnId ? " · 生成中" : ""}</div>
                </button>
              ))}
              {projects.length === 0 && <div className="py-6 text-center text-xs text-slate-400">还没有项目</div>}
            </div>
          </div>

          <label className="block rounded-2xl border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-600">
            上传基准照片
            <input
              className="mt-3 w-full text-xs"
              type="file"
              accept="image/*"
              onChange={(event) => {
                const selectedFile = event.target.files?.[0];
                setFile(selectedFile ?? null);
                setPreviewUrl(selectedFile ? URL.createObjectURL(selectedFile) : null);
              }}
            />
          </label>
          {previewUrl && <img className="aspect-square w-full rounded-2xl object-cover" src={previewUrl} alt="基准图" />}
        </aside>

        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              {isGenerating ? <>正在生成 <Spinner /></> : turn?.status === "failed" ? "生成失败" : "生成结果"}
            </h1>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{project?.name ?? "未命名项目"}</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">{turn?.userMessage ?? "描述你想要的照片风格和场景"}</p>

          <div className="mt-5">
            {latest?.candidate.url ? (
              <div className="relative">
                <DragScrollContainer className="max-h-[560px] rounded-2xl border border-slate-200 bg-slate-50">
                  <img className="w-full object-contain" src={latest.candidate.url} alt="主图" />
                </DragScrollContainer>
                <button
                  className="absolute right-3 top-3 grid size-9 place-items-center rounded-xl bg-black/50 text-white backdrop-blur hover:bg-black/70"
                  onClick={() => setLightboxUrl(latest.candidate.url)}
                  title="放大查看"
                >⤢</button>
                {!isGenerating && <div className="mt-1 text-center text-xs text-slate-400">图片较大时可按住拖动 / 滚动查看，点击右上角放大</div>}
              </div>
            ) : (
              <div className="grid aspect-[4/3] place-items-center rounded-2xl bg-slate-100 text-sm text-slate-500">{isGenerating ? "AI 正在拍摄…" : "暂无照片"}</div>
            )}
          </div>

          {candidates.length > 1 && (
            <div className="mt-4 grid grid-cols-3 gap-3">
              {candidates.map(({ generationId, candidate, selectedCandidateId }) => (
                <button key={generationId} onClick={() => select(generationId, candidate.id)}>
                  <img
                    className={`aspect-square w-full rounded-xl object-cover ring-2 ${selectedCandidateId ? "ring-violet-500" : "ring-transparent hover:ring-violet-300"}`}
                    src={candidate.url ?? ""}
                    alt="候选图"
                  />
                </button>
              ))}
            </div>
          )}

          {latest && !isGenerating && (
            <div className="mt-5 grid grid-cols-3 gap-3">
              <ActionChip icon="👍" label={latest.selectedCandidateId ? "已选择" : "满意，继续下一步"} />
              <ActionChip icon="🎛" label="微调编辑" />
              <ActionChip icon="↻" label="重新生成" onClick={() => setMessage(turn?.userMessage ?? "")} />
            </div>
          )}
        </section>

        <ChatPanel chat={chat} message={message} onMessage={setMessage} onSubmit={submit} busy={busy} error={error} onQuickAction={(value) => setMessage(value)} />
      </main>
      {lightboxUrl && <ZoomCanvas url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    </div>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setError("");
    try {
      onAuthenticated(mode === "login"
        ? await api.login({ email, password })
        : await api.register({ email, password, displayName }));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top_left,#ede9fe,transparent_35%),radial-gradient(circle_at_bottom_right,#e0e7ff,transparent_35%)] p-6">
      <div className="w-full max-w-md rounded-3xl border border-white/60 bg-white/80 p-8 shadow-2xl backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-500 text-white">📷</div>
          <div>
            <h1 className="text-xl font-semibold">AI 摄影师</h1>
            <p className="text-sm text-slate-500">让每个人都有自己的摄影师</p>
          </div>
        </div>
        <form className="mt-8 space-y-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          {mode === "register" && <Field label="昵称" value={displayName} onChange={setDisplayName} placeholder="小丸子" />}
          <Field label="邮箱" value={email} onChange={setEmail} type="email" placeholder="you@example.com" required />
          <Field label="密码" value={password} onChange={setPassword} type="password" placeholder="至少 8 位" required />
          {error && <div className="rounded-xl bg-rose-50 px-4 py-2 text-sm text-rose-600">{error}</div>}
          <button className="w-full rounded-2xl bg-gradient-to-r from-violet-500 to-indigo-500 py-3 font-medium text-white disabled:opacity-60" disabled={busy}>
            {mode === "login" ? "登录" : "注册"}
          </button>
        </form>
        <button className="mt-5 w-full text-sm text-violet-600" onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "没有账号？注册" : "已有账号？登录"}
        </button>
      </div>
    </div>
  );
}

function ChatPanel({ chat, message, onMessage, onSubmit, busy, error, onQuickAction }: {
  chat: ChatMessage[]; message: string; onMessage: (value: string) => void; onSubmit: () => void; busy: boolean;
  error: string; onQuickAction: (value: string) => void;
}) {
  return (
    <aside className="flex max-h-[calc(100vh-108px)] flex-col rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 p-5">
        <div className="flex items-center gap-2 font-semibold">AI 摄影师 <span className="rounded-md bg-violet-100 px-2 py-0.5 text-xs text-violet-700">PRO</span></div>
        <button className="text-sm text-slate-500">清空对话</button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {chat.map((item) => <Bubble key={item.id} side={item.side} time={item.time}>{item.content}</Bubble>)}
        {error && <Bubble side="left" time={timeLabel(new Date().toISOString())}>{error}</Bubble>}
      </div>
      <div className="border-t border-slate-100 p-4">
        <div className="mb-3 flex flex-wrap gap-2">
          {["换成夜景", "换衣服", "更换背景", "微笑一点", "再浪漫一点"].map((value) => (
            <button key={value} className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 hover:bg-slate-200" onClick={() => onQuickAction(value)}>{value}</button>
          ))}
        </div>
        <form className="flex items-center gap-2 rounded-2xl bg-slate-100 p-2" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
          <input
            className="min-w-0 flex-1 bg-transparent px-3 text-sm outline-none"
            placeholder="告诉我你还想怎么修改…"
            value={message}
            onChange={(event) => onMessage(event.target.value)}
          />
          <button className="grid size-9 place-items-center rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 text-white disabled:opacity-50" disabled={busy || !message.trim()}>➤</button>
        </form>
      </div>
    </aside>
  );
}

function Bubble({ side, time, children }: { side: "left" | "right"; time: string; children: React.ReactNode }) {
  return (
    <div className={side === "right" ? "flex justify-end" : "flex justify-start"}>
      <div className={`max-w-[82%] rounded-2xl px-4 py-3 text-sm ${side === "right" ? "bg-gradient-to-r from-violet-500 to-indigo-500 text-white" : "bg-slate-100 text-slate-800"}`}>
        <div className="whitespace-pre-wrap">{children}</div>
        <div className={`mt-1 text-[10px] ${side === "right" ? "text-white/70" : "text-slate-400"}`}>{time}</div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", placeholder, required }: {
  label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-slate-600">{label}</span>
      <input
        className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-violet-400 focus:ring-4 focus:ring-violet-100"
        type={type} value={value} placeholder={placeholder} required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ActionChip({ icon, label, onClick }: { icon: string; label: string; onClick?: () => void }) {
  return (
    <button className="rounded-2xl border border-slate-200 py-3 text-sm text-slate-700 hover:border-violet-300 hover:text-violet-600" onClick={onClick}>
      <span className="mr-1">{icon}</span>{label}
    </button>
  );
}

function StatusDot({ status }: { status: TurnSummary["status"] }) {
  const color = status === "failed" || status === "aborted" ? "bg-rose-500" : "bg-amber-500";
  return <span className={`size-2 shrink-0 rounded-full ${color}`} />;
}

function Spinner() {
  return <span className="inline-block size-4 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />;
}

function Avatar({ name }: { name: string }) {
  return <div className="grid size-8 place-items-center rounded-full bg-violet-100 text-sm text-violet-700">{name.slice(0, 1).toUpperCase()}</div>;
}

function useDragScroll<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const drag = useRef({ down: false, moved: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 });

  const onPointerDown = (e: React.PointerEvent<T>) => {
    const el = ref.current;
    if (!el || e.button !== 0) return;
    drag.current = { down: true, moved: false, startX: e.clientX, startY: e.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
  };
  const onPointerMove = (e: React.PointerEvent<T>) => {
    const el = ref.current;
    if (!el || !drag.current.down) return;
    const dx = e.clientX - drag.current.startX;
    const dy = e.clientY - drag.current.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.current.moved = true;
    el.scrollLeft = drag.current.scrollLeft - dx;
    el.scrollTop = drag.current.scrollTop - dy;
  };
  const end = () => { drag.current.down = false; };

  return {
    ref,
    didDrag: () => drag.current.moved,
    handlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerLeave: end },
  };
}

function DragScrollContainer({ className, children }: { className?: string; children: React.ReactNode }) {
  const { ref, handlers } = useDragScroll<HTMLDivElement>();
  return (
    <div ref={ref} className={`select-none overflow-auto cursor-grab active:cursor-grabbing ${className ?? ""}`} {...handlers}>
      {children}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ZoomCanvas({ url, onClose }: { url: string; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const drag = useRef<{ down: boolean; id: number; startX: number; startY: number; tx: number; ty: number } | null>(null);
  const fitRef = useRef<() => void>(() => undefined);

  const fitToScreen = useCallback(() => {
    const el = containerRef.current;
    const size = natural;
    if (!el || !size) return;
    const { width, height } = el.getBoundingClientRect();
    const scale = Math.min(1, (width - 48) / size.w, (height - 48) / size.h);
    setView({ scale, tx: (width - size.w * scale) / 2, ty: (height - size.h * scale) / 2 });
  }, [natural]);
  fitRef.current = fitToScreen;

  const zoomAtCenter = useCallback((factor: number) => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setView(({ scale, tx, ty }) => {
      const next = clamp(scale * factor, 0.05, 16);
      const f = next / scale;
      return { scale: next, tx: width / 2 - (width / 2 - tx) * f, ty: height / 2 - (height / 2 - ty) * f };
    });
  }, []);

  // 图片加载完成后自适应一次
  useEffect(() => {
    if (natural) fitToScreen();
  }, [natural, fitToScreen]);

  // 滚轮缩放（非 passive，才能 preventDefault）+ 键盘快捷键 + 滚动锁
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0016);
      setView(({ scale, tx, ty }) => {
        const next = clamp(scale * factor, 0.05, 16);
        const f = next / scale;
        return { scale: next, tx: px - (px - tx) * f, ty: py - (py - ty) * f };
      });
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "+" || e.key === "=") zoomAtCenter(1.25);
      if (e.key === "-") zoomAtCenter(0.8);
      if (e.key === "0") fitRef.current();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, zoomAtCenter]);

  return (
    <div className="fixed inset-0 z-50 bg-black/95">
      <div
        ref={containerRef}
        className="absolute inset-0 touch-none select-none overflow-hidden cursor-grab active:cursor-grabbing"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { down: true, id: e.pointerId, startX: e.clientX, startY: e.clientY, tx: view.tx, ty: view.ty };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || !d.down || d.id !== e.pointerId) return;
          setView(({ scale }) => ({ scale, tx: d.tx + (e.clientX - d.startX), ty: d.ty + (e.clientY - d.startY) }));
        }}
        onPointerUp={() => { if (drag.current) drag.current.down = false; }}
        onDoubleClick={() => {
          setView((current) => {
            const el = containerRef.current;
            if (!el) return current;
            const { width, height } = el.getBoundingClientRect();
            const fits = natural ? Math.min(1, (width - 48) / natural.w, (height - 48) / natural.h) : 1;
            const isBestFit = Math.abs(current.scale - fits) < 1e-4;
            if (!isBestFit) return current;
            const next = 1;
            return { scale: next, tx: (width - (natural?.w ?? 0) * next) / 2, ty: (height - (natural?.h ?? 0) * next) / 2 };
          });
        }}
      >
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          {natural ? null : <div className="text-sm text-white/60">加载中…</div>}
        </div>
        <img
          src={url}
          alt="预览"
          draggable={false}
          className="absolute left-0 top-0 max-h-none max-w-none"
          style={{
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
            transformOrigin: "0 0",
          }}
          onLoad={(e) => {
            const img = e.currentTarget;
            setNatural((current) => current ?? { w: img.naturalWidth, h: img.naturalHeight });
          }}
        />
      </div>

      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        <span className="rounded-xl bg-white/10 px-3 py-2 text-sm text-white">{Math.round(view.scale * 100)}%</span>
        <button className="grid size-10 place-items-center rounded-xl bg-white/15 text-lg text-white backdrop-blur hover:bg-white/25" title="放大 (+)" onClick={() => zoomAtCenter(1.25)}>＋</button>
        <button className="grid size-10 place-items-center rounded-xl bg-white/15 text-lg text-white backdrop-blur hover:bg-white/25" title="缩小 (-)" onClick={() => zoomAtCenter(0.8)}>－</button>
        <button className="rounded-xl bg-white/15 px-3 py-2 text-sm text-white backdrop-blur hover:bg-white/25" title="适应屏幕 (0)" onClick={fitToScreen}>适应</button>
        <button className="grid size-10 place-items-center rounded-xl bg-white/15 text-white backdrop-blur hover:bg-white/25" title="关闭 (Esc)" onClick={onClose}>✕</button>
      </div>
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-4 py-1.5 text-xs text-white/70">
        滚轮缩放 · 拖拽平移 · 双击 100% · +/− 缩放 · 0 适应 · Esc 关闭
      </div>
    </div>
  );
}

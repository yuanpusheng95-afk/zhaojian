import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, type TurnDetail, type User } from "./api";

type Screen = "auth" | "studio";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [project, setProject] = useState<{ id: string; name: string } | null>(null);
  const [turn, setTurn] = useState<TurnDetail | null>(null);
  const [message, setMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  const candidates = useMemo(
    () => turn?.generations.flatMap((generation) => generation.candidate ? [{ ...generation, candidate: generation.candidate }] : []),
    [turn],
  );
  const selected = candidates?.find((generation) => generation.selectedCandidateId);
  const latest = selected ?? candidates?.at(-1);
  const isGenerating = turn?.status === "queued" || turn?.status === "running";

  const submit = useCallback(async () => {
    if (!message.trim() || busy) return;
    setBusy(true);
    setError("");
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
      }
      const created = await api.sendMessage(currentProject.id, message);
      setTurn(await api.turn(currentProject.id, created.turnId));
      setMessage("");
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
    source.addEventListener("done", () => source.close());
    source.addEventListener("error", () => source.close());
    return () => source.close();
  }, [isGenerating, project, turn]);

  const select = useCallback(async (generationId: string, candidateId: string) => {
    if (!project || !turn) return;
    await api.select(project.id, turn.turnId, generationId, candidateId);
    setTurn(await api.turn(project.id, turn.turnId));
  }, [project, turn]);

  if (loading) {
    return <div className="grid min-h-screen place-items-center text-sm text-slate-500">加载中…</div>;
  }

  if (!user) {
    return <AuthScreen onAuthenticated={setUser} />;
  }

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
            <button className="text-sm text-slate-500 hover:text-slate-800" onClick={async () => { await api.logout(); setUser(null); }}>
              退出
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1500px] gap-5 px-6 py-5 lg:grid-cols-[280px_minmax(0,1fr)_430px]">
        <aside className="space-y-4">
          <button
            className="w-full rounded-2xl bg-gradient-to-r from-violet-500 to-indigo-500 py-3 font-medium text-white shadow-lg shadow-violet-500/20"
            onClick={() => { setProject(null); setTurn(null); setMessage(""); setFile(null); setPreviewUrl(null); }}
          >
            ＋ 新建项目
          </button>
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-sm font-semibold">当前项目</div>
            <div className="mt-2 text-sm text-slate-600">{project?.name ?? "尚未创建"}</div>
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
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">版本 1/1</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">{turn?.userMessage ?? "描述你想要的照片风格和场景"}</p>

          <div className="mt-5">
            {latest?.candidate.url
              ? <img className="aspect-[4/3] w-full rounded-2xl object-cover" src={latest.candidate.url} alt="主图" />
              : <div className="grid aspect-[4/3] place-items-center rounded-2xl bg-slate-100 text-sm text-slate-500">{isGenerating ? "AI 正在拍摄…" : "暂无照片"}</div>}
          </div>

          {candidates && candidates.length > 1 && (
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
              <ActionChip icon="↻" label="重新生成" onClick={() => { setMessage(turn?.userMessage ?? ""); }} />
            </div>
          )}
        </section>

        <ChatPanel
          message={message}
          onMessage={setMessage}
          onSubmit={submit}
          busy={busy}
          turn={turn}
          error={error}
          onQuickAction={(value) => setMessage(value)}
        />
      </main>
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

function ChatPanel({ message, onMessage, onSubmit, busy, turn, error, onQuickAction }: {
  message: string; onMessage: (value: string) => void; onSubmit: () => void; busy: boolean;
  turn: TurnDetail | null; error: string; onQuickAction: (value: string) => void;
}) {
  return (
    <aside className="flex max-h-[calc(100vh-108px)] flex-col rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 p-5">
        <div className="flex items-center gap-2 font-semibold">AI 摄影师 <span className="rounded-md bg-violet-100 px-2 py-.5 text-xs text-violet-700">PRO</span></div>
        <button className="text-sm text-slate-500">清空对话</button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        <Bubble side="left">
          你好！我是你的 AI 摄影师 📸
          <br />上传一张照片，告诉我想要的风格、场景和氛围，我来帮你生成。
        </Bubble>
        {turn && <>
          <Bubble side="right">{turn.userMessage}</Bubble>
          <Bubble side="left">
            {turn.status === "queued" || turn.status === "running" ? "正在为你拍摄…" : turn.status === "failed" ? "这次拍摄失败了，请换个描述试试。" : "这是生成的照片，你可以继续告诉我要怎么调整。"}
          </Bubble>
        </>}
        {error && <Bubble side="left">{error}</Bubble>}
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

function Bubble({ side, children }: { side: "left" | "right"; children: React.ReactNode }) {
  return (
    <div className={side === "right" ? "flex justify-end" : "flex justify-start"}>
      <div className={`max-w-[82%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm ${side === "right" ? "bg-gradient-to-r from-violet-500 to-indigo-500 text-white" : "bg-slate-100 text-slate-800"}`}>{children}</div>
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

function Spinner() {
  return <span className="inline-block size-4 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />;
}

function Avatar({ name }: { name: string }) {
  return <div className="grid size-8 place-items-center rounded-full bg-violet-100 text-sm text-violet-700">{name.slice(0, 1).toUpperCase()}</div>;
}

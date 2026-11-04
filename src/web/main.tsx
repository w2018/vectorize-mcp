import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, setCsrf, type Account, type Page } from "./api";
import { Feedback, Heading, State, useAction, useResource } from "./ui";
import { Memories } from "./memories";
import { Accounts, Backups, Transfer, Settings, AuditLog } from "./management";
import { GraphView, Stats, Suggestions } from "./insights";
import "./style.css";
const navigation = [
  ["memories", "▤", "记忆"],
  ["profiles", "◉", "关于我"],
  ["graph", "✧", "记忆星图"],
  ["stats", "▥", "统计"],
  ["suggestions", "✓", "整理建议"],
  ["tokens", "⌘", "账户与凭据"],
  ["transfer", "⇄", "数据搬家"],
  ["backups", "◷", "备份"],
  ["settings", "⚙", "设置"],
  ["audit", "≡", "操作记录"],
] as const;
function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [page, setPage] = useState("memories");
  const [subject, setSubject] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [password, setPassword] = useState("");
  const action = useAction();
  const accounts = useResource<Page<Account>>(
    authenticated ? "/accounts" : null,
    refresh,
  );
  const loadSession = () => {
    setSessionError("");
    api<{ authenticated: boolean; csrf_token: string }>("/auth/session")
      .then((s) => {
        setCsrf(s.csrf_token);
        setAuthenticated(s.authenticated);
      })
      .catch((e) => {
        setAuthenticated(false);
        setSessionError(e.message);
      });
  };
  useEffect(() => {
    loadSession();
    const expired = () => {
      setCsrf("");
      setAuthenticated(false);
      setPassword("");
      loadSession();
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  useEffect(() => {
    if (accounts.data && !accounts.data.items.some((a) => a.id === subject))
      setSubject(accounts.data.items[0]?.id || "");
  }, [accounts.data, subject]);
  const reload = () => setRefresh((v) => v + 1);
  if (authenticated === null)
    return (
      <main className="login">
        <State loading error="">
          {null}
        </State>
      </main>
    );
  if (!authenticated)
    return (
      <main className="login">
        <section className="login-card">
          <div className="brandmark">✧</div>
          <span className="eyebrow">VECTORIZE · MEMORY</span>
          <h1>
            让有用的记忆
            <br />
            留在身边。
          </h1>
          <p>登录管理后台，查看和整理你的长期记忆。</p>
          <Feedback error={action.error || sessionError} notice="" />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                await api("/auth/login", "POST", { password });
                setPassword("");
                loadSession();
              }, "");
            }}
          >
            <label>
              管理员密码
              <input
                autoFocus
                type="password"
                required
                value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button className="primary" disabled={action.busy}>
              {action.busy ? "正在登录…" : "进入我的记忆 →"}
            </button>
          </form>
          <small>
            首次使用？请先在服务器运行本机管理员初始化命令。MCP
            访问凭据不能用于登录后台。
          </small>
        </section>
      </main>
    );
  const scoped = [
    "memories",
    "profiles",
    "graph",
    "stats",
    "suggestions",
    "transfer",
  ].includes(page);
  return (
    <div className="app">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("memories");
          }}
        >
          <span className="brandmark">✧</span>
          <div>
            <strong>记忆</strong>
            <small>VECTORIZE</small>
          </div>
        </a>
        <div className="workspace-label">我的工作空间</div>
        <nav aria-label="主导航">
          {navigation.map(([key, icon, label]) => (
            <button
              key={key}
              className={page === key ? "active" : ""}
              onClick={() => setPage(key)}
              aria-current={page === key ? "page" : undefined}
            >
              <span>{icon}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="status-dot" />
          独立账户 · 安全管理<small>每一条记忆，都由你掌握。</small>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <label className="account-select">
            当前账户
            <select
              aria-label="当前记忆账户"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={accounts.loading}
            >
              <option value="">
                {accounts.loading ? "读取中…" : "选择账户"}
              </option>
              {accounts.data?.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.status === "unbound" ? " · 未绑定凭据" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="toolbar">
            <button onClick={reload}>刷新</button>
            <button
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api("/auth/logout", "POST", {});
                  setAuthenticated(false);
                  setCsrf("");
                  setSubject("");
                  loadSession();
                }, "")
              }
            >
              退出
            </button>
          </div>
        </header>
        <main className="content">
          <Feedback error={action.error || accounts.error} notice="" />
          {scoped && !subject ? (
            <>
              <Heading
                eyebrow="WELCOME"
                title="从一个记忆账户开始"
                description="不同账户的记忆彼此隔离。创建访问凭据时，会自动建立一个新账户。"
              />
              <button className="primary" onClick={() => setPage("tokens")}>
                创建第一个账户
              </button>
            </>
          ) : (
            <React.Fragment key={scoped ? page + subject : page}>
              {page === "memories" && (
                <Memories subject={subject} refresh={refresh} />
              )}
              {page === "profiles" && (
                <Memories subject={subject} refresh={refresh} profiles />
              )}
              {page === "graph" && (
                <GraphView subject={subject} refresh={refresh} />
              )}
              {page === "stats" && (
                <Stats subject={subject} refresh={refresh} />
              )}
              {page === "suggestions" && (
                <Suggestions subject={subject} refresh={refresh} />
              )}
              {page === "tokens" && (
                <Accounts refresh={refresh} onChange={reload} />
              )}
              {page === "transfer" && <Transfer subject={subject} />}
              {page === "backups" && <Backups refresh={refresh} />}
              {page === "settings" && <Settings refresh={refresh} />}
              {page === "audit" && <AuditLog refresh={refresh} />}
            </React.Fragment>
          )}
        </main>
        <footer className="page-foot">
          记忆是可核对的历史信息，本轮需求始终优先。
        </footer>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

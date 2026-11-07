import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, setCsrf, type Account, type Page } from "./api";
import { Feedback, Heading, State, useAction, useResource } from "./ui";
import { Memories } from "./memories";
import { Accounts, Backups, Settings, AuditLog } from "./management";
import { GraphView, Stats, Suggestions } from "./insights";
import "./style.css";
import { Trash } from "./trash";
import { About } from "./about";
import { QQBot } from "./qqbot";
const navigation = [
  ["stats", "▥", "统计面板"],
  ["memories", "▤", "记忆"],
  ["graph", "✧", "记忆星图"],
  ["suggestions", "✓", "记忆整理"],
  ["tokens", "⌘", "账户与凭据"],
  ["backups", "◷", "备份与数据"],
  ["settings", "⚙", "设置"],
  ["audit", "≡", "操作记录"],
  ["qqbot", "✦", "QQBOT 人设"],
  ["trash", "♲", "回收站"],
  ["about", "ⓘ", "关于"],
] as const;
const scopedPages = ["memories", "graph", "stats", "suggestions"];
function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [page, setPage] = useState("stats");
  const [subject, setSubject] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [password, setPassword] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
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
    if (accounts.data && !accounts.data.items.some((a) => a.id === subject)) {
      let remembered = "";
      try { remembered = localStorage.getItem("vectorize.last-subject") || ""; } catch { /* storage may be disabled */ }
      setSubject(accounts.data.items.some(a => a.id === remembered) ? remembered : accounts.data.items[0]?.id || "");
    }
  }, [accounts.data, subject]);
  const accountItems = accounts.data?.items || [];
  const hasQQBot = accountItems.some((account) => account.kind === "qqbot");
  const instanceKey = scopedPages.includes(page)
    ? page + ":" + subject
    : page;
  const [mounted, setMounted] = useState<string[]>([]);
  const scrollPositions = useRef(new Map<string, number>());
  const navigate = (next: string) => {
    scrollPositions.current.set(instanceKey, window.scrollY);
    setPage(next);
    setMenuOpen(false);
  };
  const selectSubject = (next: string) => {
    scrollPositions.current.set(instanceKey, window.scrollY);
    setSubject(next);
  };
  useEffect(() => {
    if (subject) {
      try {
        localStorage.setItem("vectorize.last-subject", subject);
      } catch {
        /* storage may be disabled */
      }
    }
    if (page === "qqbot" && accounts.data && !hasQQBot) setPage("stats");
  }, [accounts.data, hasQQBot, page, subject]);
  useEffect(() => {
    if (scopedPages.includes(page) && !subject) return;
    setMounted((current) =>
      current.includes(instanceKey) ? current : [...current, instanceKey],
    );
  }, [instanceKey, page, subject]);
  useEffect(() => {
    if (!accounts.data) return;
    const valid = new Set(accounts.data.items.map((account) => account.id));
    setMounted((current) => {
      const next = current.filter((key) => {
        const separator = key.indexOf(":");
        return separator < 0 || valid.has(key.slice(separator + 1));
      });
      return next.length === current.length ? current : next;
    });
  }, [accounts.data]);
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      window.scrollTo({ top: scrollPositions.current.get(instanceKey) || 0 }),
    );
    return () => cancelAnimationFrame(frame);
  }, [instanceKey]);
  const reload = () => setRefresh((v) => v + 1);
  useEffect(() => {
    const changed = () => setRefresh((v) => v + 1);
    window.addEventListener("memory-data-changed", changed);
    return () => window.removeEventListener("memory-data-changed", changed);
  }, []);
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
              {action.busy ? "正在登录" : "进入我的记忆 →"}
            </button>
          </form>
          <small>
            首次使用？请先在服务器运行本机管理员初始化命令。MCP
            访问凭据不能用于登录后台。
          </small>
        </section>
      </main>
    );
  function renderPage(instance: string) {
    const separator = instance.indexOf(":");
    const name = separator < 0 ? instance : instance.slice(0, separator);
    const pageSubject = separator < 0 ? "" : instance.slice(separator + 1);
    const pageKind =
      accountItems.find((account) => account.id === pageSubject)?.kind ||
      "standard";
    switch (name) {
      case "memories":
        return (
          <Memories
            subject={pageSubject}
            accounts={accountItems}
            refresh={refresh}
          />
        );
      case "graph":
        return (
          <GraphView subject={pageSubject} refresh={refresh} kind={pageKind} />
        );
      case "stats":
        return (
          <Stats
            subject={pageSubject}
            refresh={refresh}
            onSelectAccount={selectSubject}
          />
        );
      case "suggestions":
        return <Suggestions subject={pageSubject} refresh={refresh} />;
      case "qqbot":
        return (
          <QQBot subject={subject} accounts={accountItems} refresh={refresh} />
        );
      case "tokens":
        return <Accounts refresh={refresh} onChange={reload} />;
      case "backups":
        return <Backups subject={subject} refresh={refresh} />;
      case "settings":
        return <Settings refresh={refresh} />;
      case "audit":
        return <AuditLog refresh={refresh} />;
      case "trash":
        return <Trash refresh={refresh} />;
      case "about":
        return <About />;
      default:
        return null;
    }
  }
  return (
    <div className="app">
      <button
        type="button"
        className={menuOpen ? "sidebar-overlay open" : "sidebar-overlay"}
        aria-label="关闭菜单"
        onClick={() => setMenuOpen(false)}
      />
      <aside className={menuOpen ? "sidebar open" : "sidebar"}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("stats");
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
          {navigation
            .filter(([key]) => key !== "qqbot" || hasQQBot)
            .map(([key, icon, label]) => (
            <button
              key={key}
              className={page === key ? "active" : ""}
              onClick={() => navigate(key)}
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
          <button
            type="button"
            className="mobile-menu"
            aria-label="打开菜单"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            ☰
          </button>
          <label className="account-select">
            当前账户
            <select
              aria-label="当前记忆账户"
              value={subject}
              onChange={(e) => selectSubject(e.target.value)}
              disabled={accounts.loading}
            >
              <option value="">
                {accounts.loading ? "读取中" : "选择账户"}
              </option>
              {accounts.data?.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.kind === "qqbot" ? " · QQBOT" : ""}
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
          {scopedPages.includes(page) && !subject ? (
            <>
              <Heading
                eyebrow="WELCOME"
                title="从一个记忆账户开始"
                description="不同账户的记忆彼此隔离。创建访问凭据时，会自动建立一个新账户。"
              />
              <button className="primary" onClick={() => navigate("tokens")}>
                创建第一个账户
              </button>
            </>
          ) : (
            mounted.map((instance) => (
              <div
                className="page-instance"
                key={instance}
                hidden={instance !== instanceKey}
              >
                {renderPage(instance)}
              </div>
            ))
          )}
        </main>
        <footer className="page-foot">
          记忆是可核对的历史信息，本轮需求始终优先。
        </footer>
      </div>
    </div>
  );
}
// D-19/R-04: decide the mobile layout by the same viewport query used by the
// CSS media rules, and keep it in sync on resize / orientation changes. A
// one-shot UA sniff disagrees with the stylesheet on narrow desktops and wide
// touch devices.
const mobileQuery = window.matchMedia("(max-width: 720px)");
function syncMobileLayout() {
  document.documentElement.dataset.mobile = mobileQuery.matches ? "true" : "false";
}
syncMobileLayout();
mobileQuery.addEventListener("change", syncMobileLayout);
window.addEventListener("resize", syncMobileLayout);
window.addEventListener("orientationchange", syncMobileLayout);
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

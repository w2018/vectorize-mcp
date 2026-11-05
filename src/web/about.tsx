import { Heading } from "./ui";
export function About() {
  return (
    <>
      <Heading
        eyebrow="ABOUT VECTORIZE"
        title="关于"
        description="让值得记住的信息保持清晰、可核对、由你掌握。"
      />
      <section className="panel padded">
        <div className="brandmark">✧</div>
        <h2>Vectorize MCP</h2>
        <dl className="details">
          <dt>作者</dt>
          <dd>w2018</dd>
          <dt>版本</dt>
          <dd>0.2.0</dd>
          <dt>开源协议</dt>
          <dd>MIT</dd>
          <dt>开源地址</dt>
          <dd>
            <a
              href="https://github.com/w2018/vectorize-mcp"
              target="_blank"
              rel="noopener noreferrer"
            >
              github.com/w2018/vectorize-mcp ↗
            </a>
          </dd>
        </dl>
        <p>一个支持多账户隔离、语义检索与人工管理的长期记忆服务。</p>
      </section>
    </>
  );
}

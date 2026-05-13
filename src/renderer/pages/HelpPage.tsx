import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import "./HelpPage.css";

/* ================================================================
 *  静态帮助数据
 * ================================================================ */

interface HelpItem {
  question: string;
  answer: ReactNode;
}

interface HelpCategory {
  id: string;
  label: string;
  items: HelpItem[];
}

type HelpPageProps = {
  isWindows: boolean;
};

function getHelpCategories(isWindows: boolean): HelpCategory[] {
  const pluginArchiveLabel = isWindows ? ".zip" : ".tar.gz";
  const pluginArchiveCommand = isWindows
    ? "Compress-Archive -LiteralPath .\\my-plugin -DestinationPath .\\my-plugin.zip"
    : "tar -czf my-plugin.tar.gz -C /path/to my-plugin/";

  return [
  /* ── 热门问题 ── */
  {
    id: "popular",
    label: "热门问题",
    items: [
      {
        question: "什么是 ZenMind？",
        answer: (
          <>
            <p>
              ZenMind 是一个桌面控制壳应用，用于统一管理和运行内置服务与第三方插件。
              它基于 Electron 构建，提供服务发现、安装、启停、日志查看和配置管理等能力。
            </p>
            <p>
              应用支持两种服务来源：
              <Link className="help-inline-link" to="/control-center">
                <strong>内置服务</strong>
              </Link>
              （随应用打包分发）和
              <Link className="help-inline-link" to="/market">
                <strong>插件</strong>
              </Link>
              （运行时通过 <code>{pluginArchiveLabel}</code> 包导入）。
            </p>
          </>
        ),
      },
      {
        question: "如何安装与首次启动？",
        answer: (
          <>
            <ol>
              <li>
                <strong>macOS</strong>：打开 <code>.dmg</code> 文件，将 ZenMind 拖入"应用程序"文件夹
              </li>
              <li>
                <strong>Windows</strong>：运行 NSIS 安装包，按提示完成安装
              </li>
              <li>
                首次启动后，
                <Link className="help-inline-link" to="/control-center">
                  控制中心
                </Link>
                会列出所有内置服务，点击"安装"即可部署
              </li>
              <li>安装完成后点击"启动"按钮，服务状态变为绿色即表示运行正常</li>
            </ol>
          </>
        ),
      },
      {
        question: "系统要求与环境准备",
        answer: (
          <>
            <ul>
              <li>
                <strong>操作系统</strong>：macOS (arm64) 或 Windows (x64)
              </li>
              <li>
                <strong>Node.js</strong>：v18 或更高版本（开发环境）
              </li>
              <li>
                <strong>Docker / Podman</strong>：如需使用容器仓库（agent-container-hub）服务，需要安装
                Docker Desktop 或 Podman
              </li>
              <li>
                <strong>磁盘空间</strong>：建议预留至少 2GB 可用空间
              </li>
            </ul>
          </>
        ),
      },
      {
        question: "数据目录在哪里？",
        answer: (
          <>
            <p>应用运行数据存储在桌面端的数据目录中：</p>
            <ul>
              <li>
                <strong>macOS</strong>：<code>~/Library/Application Support/zenmind-desktop/</code>
              </li>
              <li>
                <strong>Windows</strong>：<code>&lt;安装目录&gt;\data\</code>，例如 <code>D:\ZenMind\data\</code>
              </li>
            </ul>
            <p>
              该目录包含已安装服务的运行文件、插件目录 (<code>plugins/</code>)、
              密钥文件 (<code>credentials/</code>) 以及各服务的配置和日志。
            </p>
          </>
        ),
      },
      {
        question: "服务之间的依赖关系",
        answer: (
          <>
            <p>内置服务的推荐启动顺序：</p>
            <ol>
              <li>
                <strong>容器仓库（agent-container-hub）</strong>（最先启动，确保 Docker/Podman 可用）
              </li>
              <li>
                <strong>agent-platform</strong>（依赖容器仓库）
              </li>
              <li>
                <strong>zenmind-app-server</strong>（可独立启动）
              </li>
            </ol>
            <p>如果不使用智能体功能，可以只启动 zenmind-app-server。</p>
          </>
        ),
      },
    ],
  },

  /* ── 服务管理 ── */
  {
    id: "service-management",
    label: "服务管理",
    items: [
      {
        question: "服务启动失败怎么办？",
        answer: (
          <>
            <ol>
              <li>
                检查服务状态是否为 <code>config-required</code>
                ——如果是，需要先完善配置文件
              </li>
              <li>
                查看服务日志（在详情卡片中点击"日志"标签），定位具体错误信息
              </li>
              <li>
                确认依赖服务是否已启动。例如 agent-platform 依赖容器仓库先运行
              </li>
              <li>尝试"重启"按钮，有时进程残留会导致启动失败</li>
            </ol>
          </>
        ),
      },
      {
        question: "提示端口被占用如何处理？",
        answer: (
          <>
            <p>如果服务启动时提示端口冲突，说明该端口已被其他程序占用。</p>
            <p>你可以通过以下命令查找占用进程：</p>
            <pre>
              <code># macOS / Linux{"\n"}lsof -i :端口号{"\n"}{"\n"}# Windows{"\n"}netstat -ano | findstr :端口号</code>
            </pre>
            <p>找到占用进程后，关闭对应程序或修改服务的配置文件中的端口号。</p>
          </>
        ),
      },
      {
        question: "状态显示 dependency-missing 是什么意思？",
        answer: (
          <>
            <p>
              <code>dependency-missing</code> 表示该服务的前置依赖未满足。常见原因包括：
            </p>
            <ul>
              <li>容器仓库（agent-container-hub）需要 Docker 或 Podman，但本机未安装或未启动</li>
              <li>某些服务依赖其他内置服务先完成安装</li>
            </ul>
            <p>请根据详情卡片中的"前置条件"列表逐项检查并满足依赖。</p>
          </>
        ),
      },
      {
        question: "如何重置服务配置？",
        answer: (
          <>
            <p>
              每个服务的安装目录下都有一份 <code>.env.example</code> 配置模板。如果你需要重置配置：
            </p>
            <ol>
              <li>
                在
                <Link className="help-inline-link" to="/control-center">
                  控制中心
                </Link>
                找到对应服务，打开详情
              </li>
              <li>
                删除或重命名当前 <code>.env</code> 文件
              </li>
              <li>
                重新安装或重启服务，系统会自动从 <code>.env.example</code> 恢复默认配置
              </li>
            </ol>
          </>
        ),
      },
    ],
  },

  /* ── 插件系统 ── */
  {
    id: "plugins",
    label: "插件系统",
    items: [
      {
        question: "插件安装后为什么不显示？",
        answer: (
          <>
            <p>请检查以下几点：</p>
            <ul>
              <li>
                插件包 (<code>{pluginArchiveLabel}</code>) 内必须包含有效的{" "}
                <code>manifest.json</code> 文件
              </li>
              <li>
                <code>manifest.json</code> 中的 <code>kind</code> 字段必须为{" "}
                <code>"plugin"</code>
              </li>
              <li>确认插件 ID 没有与已安装的插件冲突</li>
              <li>查看主进程日志确认是否有加载错误</li>
            </ul>
          </>
        ),
      },
      {
        question: "如何打包和安装插件？",
        answer: (
          <>
            <ol>
              <li>确保插件根目录包含有效的 <code>manifest.json</code></li>
              <li>
                将插件目录打包为 <code>{pluginArchiveLabel}</code> 文件：
                <pre>
                  <code>{pluginArchiveCommand}</code>
                </pre>
              </li>
              <li>
                在
                <Link className="help-inline-link" to="/control-center">
                  控制中心
                </Link>
                点击"安装插件"按钮，选择打包好的文件
              </li>
              <li>安装完成后，插件会立即出现在控制中心的服务列表中</li>
            </ol>
          </>
        ),
      },
      {
        question: "前端模式 (frontendMode) 有哪几种？",
        answer: (
          <>
            <ul>
              <li>
                <strong><code>none</code></strong>：无前端界面，仅在控制中心显示服务卡片
              </li>
              <li>
                <strong><code>embedded</code></strong>
                ：内嵌前端，可在详情页通过 iframe 打开，不会出现在顶部导航栏
              </li>
              <li>
                <strong><code>standalone</code></strong>
                ：独立前端，运行中会自动出现在顶部导航栏，可在详情页打开
              </li>
            </ul>
          </>
        ),
      },
      {
        question: "认证桥接 (Token Bridge) 如何使用？",
        answer: (
          <>
            <p>
              需要认证的插件可通过 postMessage Token Bridge 与 Desktop 通信，获取 JWT 令牌：
            </p>
            <ol>
              <li>
                插件 iframe 发送消息：
                <pre>
                  <code>{`{
  type: "REQUEST_TYPE",
  requestId: "唯一ID",
  action: "getAccessToken",
  reason: "missing"
}`}</code>
                </pre>
              </li>
              <li>
                Desktop 签发 JWT 后回传：
                <pre>
                  <code>{`{
  type: "RESPONSE_TYPE",
  requestId: "唯一ID",
  token: "jwt-token-string"
}`}</code>
                </pre>
              </li>
            </ol>
            <p>
              认证协议定义在 <code>src/shared/auth-bridge.ts</code> 中。
            </p>
          </>
        ),
      },
    ],
  },

  /* ── 日志与排查 ── */
  {
    id: "troubleshooting",
    label: "日志与排查",
    items: [
      {
        question: "日志文件在哪里？",
        answer: (
          <>
            <p>
              每个服务的日志路径可在
              <Link className="help-inline-link" to="/control-center">
                控制中心
              </Link>
              详情卡片中查看。通常位于服务安装目录下：
            </p>
            <ul>
              <li>
                <strong>主日志</strong>：来自服务清单中的 <code>runtime.logRelativePath</code>，控制中心详情页会显示实际路径
              </li>
              <li>
                <strong>独立错误日志</strong>：仅当服务清单声明 <code>runtime.errorLogRelativePath</code> 时才会单独显示
              </li>
              <li>
                当前 macOS / Linux 内置服务默认将 <code>stderr</code> 合并写入主日志，不会额外生成单独错误日志文件
              </li>
            </ul>
            <p>
              你也可以通过
              <Link className="help-inline-link" to="/control-center">
                控制中心
              </Link>
              的相关服务详情直接查看日志路径和运行信息。
            </p>
          </>
        ),
      },
      {
        question: "常见错误信息与解决方案",
        answer: (
          <>
            <ul>
              <li>
                <strong>EADDRINUSE</strong>：端口已被占用，参考上方的端口排查方法
              </li>
              <li>
                <strong>EACCES</strong>：权限不足，检查安装目录和脚本的执行权限
              </li>
              <li>
                <strong>ENOENT</strong>：文件不存在，确认服务已正确安装且资源文件完整
              </li>
              <li>
                <strong>Docker daemon not running</strong>
                ：需要启动 Docker Desktop 或 Podman
              </li>
            </ul>
          </>
        ),
      },
      {
        question: "PID 文件与进程管理",
        answer: (
          <>
            <p>服务启动后会在运行目录写入 PID 文件，用于跟踪进程状态。</p>
            <ul>
              <li>PID 文件路径可在详情卡片的健康信息中查看</li>
              <li>如果服务异常退出，PID 文件可能残留。此时重启服务会自动清理</li>
              <li>
                应用退出时（<code>before-quit</code>）会记录正在运行的服务，并在下次启动后尝试恢复
              </li>
            </ul>
          </>
        ),
      },
      {
        question: "如何提交问题报告？",
        answer: (
          <>
            <p>如果遇到无法自行解决的问题，建议提交时附上以下信息：</p>
            <ol>
              <li>操作系统版本和架构</li>
              <li>ZenMind 版本号</li>
              <li>出问题的服务名称和状态截图</li>
              <li>相关日志文件内容（脱敏处理后）</li>
              <li>复现步骤</li>
            </ol>
          </>
        ),
      },
    ],
  },

  /* ── 快捷键 ── */
  {
    id: "shortcuts",
    label: "快捷键",
    items: [
      {
        question: "全局快捷键",
        answer: (
          <>
            <ul>
              <li>
                <kbd>Cmd</kbd> + <kbd>R</kbd> / <kbd>Ctrl</kbd> +{" "}
                <kbd>R</kbd>：刷新当前页面
              </li>
              <li>
                <kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>I</kbd> /{" "}
                <kbd>F12</kbd>：打开开发者工具 (DevTools)
              </li>
              <li>
                <kbd>Cmd</kbd> + <kbd>Q</kbd> / <kbd>Alt</kbd> +{" "}
                <kbd>F4</kbd>：退出应用
              </li>
            </ul>
          </>
        ),
      },
      {
        question: "导航操作",
        answer: (
          <>
            <p>
              顶部导航栏支持点击切换页面。运行中且前端模式为{" "}
              <code>standalone</code> 的服务会自动出现在导航栏中间区域。
            </p>
            <p>固定导航项：</p>
            <ul>
              <li>
                <Link className="help-inline-link" to="/control-center">
                  <strong>控制中心</strong>
                </Link>
                ：管理所有服务的启停和配置
              </li>
              <li>
                <Link className="help-inline-link" to="/market">
                  <strong>功能市场</strong>
                </Link>
                ：浏览和安装插件（即将推出）
              </li>
              <li>
                <Link className="help-inline-link" to="/help">
                  <strong>帮助</strong>
                </Link>
                ：当前页面
              </li>
            </ul>
          </>
        ),
      },
    ],
  },
  ];
}

/* ================================================================
 *  组件
 * ================================================================ */

const ACCORDION_FALLBACK_HEIGHT = 800;

export function HelpPage({ isWindows }: HelpPageProps) {
  const helpCategories = getHelpCategories(isWindows);
  const [activeCat, setActiveCat] = useState(() => helpCategories[0]?.id ?? "popular");
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const bodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const contentRef = useRef<HTMLDivElement>(null);

  /* ── 进入/离开时切换 header 为白色主题 ── */
  useEffect(() => {
    document.documentElement.classList.add("theme-help");
    return () => document.documentElement.classList.remove("theme-help");
  }, []);

  const currentCategory = helpCategories.find((c) => c.id === activeCat) ?? helpCategories[0];

  /* ── 切换类别 ── */
  const switchCategory = useCallback((catId: string) => {
    setActiveCat(catId);
    setOpenItems(new Set());
    contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  /* ── 手风琴展开/折叠 ── */
  const toggleItem = useCallback((key: string) => {
    setOpenItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <section className="help-page">
      {/* 主体双栏 */}
      <div className="help-layout">
        {/* 左侧导航 */}
        <aside className="help-sidebar">
          <h2 className="help-sidebar-title">支持中心</h2>
          <nav className="help-nav">
            {helpCategories.map((cat) => (
              <button
                key={cat.id}
                className={`help-nav-btn${activeCat === cat.id ? " is-active" : ""}`}
                onClick={() => switchCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* 右侧内容 */}
        <div className="help-main" ref={contentRef}>
          <div className="help-hero">
            <h1 className="help-hero-title">我们能为您提供什么帮助？</h1>
            <p className="help-hero-desc">
              浏览下方常见问题，或选择左侧分类查找更多信息。
            </p>
          </div>

          <div className="help-faq-list">
            {currentCategory.items.map((item, idx) => {
              const key = `${activeCat}-${idx}`;
              const isOpen = openItems.has(key);
              return (
                <div
                  key={key}
                  className={`help-faq-item${isOpen ? " is-open" : ""}`}
                >
                  <button
                    className="help-faq-trigger"
                    onClick={() => toggleItem(key)}
                    aria-expanded={isOpen}
                  >
                    <span className="help-faq-question">{item.question}</span>
                    <svg
                      className="help-faq-chevron"
                      width="20"
                      height="20"
                      viewBox="0 0 20 20"
                      fill="none"
                    >
                      <path
                        d="M5 7.5L10 12.5L15 7.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  <div
                    className="help-faq-body"
                    ref={(el) => {
                      if (el) bodyRefs.current.set(key, el);
                      else bodyRefs.current.delete(key);
                    }}
                    style={{
                      maxHeight: isOpen
                        ? `${bodyRefs.current.get(key)?.scrollHeight ?? ACCORDION_FALLBACK_HEIGHT}px`
                        : "0px",
                    }}
                  >
                    <div className="help-faq-answer">{item.answer}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

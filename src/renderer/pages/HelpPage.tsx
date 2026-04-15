import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./HelpPage.css";

/* ================================================================
 *  静态帮助数据
 * ================================================================ */

interface HelpItem {
  question: string;
  answer: ReactNode;
}

interface HelpSection {
  id: string;
  eyebrow: string;
  title: string;
  items: HelpItem[];
}

const HELP_SECTIONS: HelpSection[] = [
  /* ── 快速开始 ── */
  {
    id: "quick-start",
    eyebrow: "Quick Start",
    title: "快速开始",
    items: [
      {
        question: "什么是 ZenMind Desktop？",
        answer: (
          <>
            <p>
              ZenMind Desktop 是一个桌面端控制壳应用，用于统一管理和运行内置服务与第三方插件。
              它基于 Electron 构建，提供服务发现、安装、启停、日志查看和配置管理等能力。
            </p>
            <p>
              应用支持两种服务来源：<strong>内置服务</strong>（随应用打包分发）和
              <strong>插件</strong>（运行时通过 <code>.tar.gz</code> 包导入）。
            </p>
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
                <strong>Docker / Podman</strong>：如需使用 agent-container-hub 服务，需要安装
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
        question: "安装与首次启动",
        answer: (
          <>
            <ol>
              <li>
                <strong>macOS</strong>：打开 <code>.dmg</code> 文件，将 ZenMind 拖入"应用程序"文件夹
              </li>
              <li>
                <strong>Windows</strong>：运行 NSIS 安装包，按提示完成安装
              </li>
              <li>首次启动后，控制中心会列出所有内置服务，点击"安装"即可部署</li>
              <li>安装完成后点击"启动"按钮，服务状态变为绿色即表示运行正常</li>
            </ol>
          </>
        ),
      },
      {
        question: "数据目录在哪里？",
        answer: (
          <>
            <p>应用运行数据存储在 Electron 的 <code>userData</code> 路径下：</p>
            <ul>
              <li>
                <strong>macOS</strong>：<code>~/Library/Application Support/zenmind-desktop/</code>
              </li>
              <li>
                <strong>Windows</strong>：<code>%APPDATA%/zenmind-desktop/</code>
              </li>
            </ul>
            <p>
              该目录包含已安装服务的运行文件、插件目录 (<code>plugins/</code>)、
              密钥文件 (<code>credentials/</code>) 以及各服务的配置和日志。
            </p>
          </>
        ),
      },
    ],
  },

  /* ── 常见问题 ── */
  {
    id: "faq",
    eyebrow: "FAQ",
    title: "常见问题",
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
                确认依赖服务是否已启动。例如 agent-platform 依赖
                agent-container-hub 先运行
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
            <p>
              如果服务启动时提示端口冲突，说明该端口已被其他程序占用。
            </p>
            <p>你可以通过以下命令查找占用进程：</p>
            <pre>
              <code># macOS / Linux{"\n"}lsof -i :端口号{"\n"}{"\n"}# Windows{"\n"}netstat -ano | findstr :端口号</code>
            </pre>
            <p>
              找到占用进程后，关闭对应程序或修改服务的配置文件中的端口号。
            </p>
          </>
        ),
      },
      {
        question: "状态显示 dependency-missing 是什么意思？",
        answer: (
          <>
            <p>
              <code>dependency-missing</code> 表示该服务的前置依赖未满足。
              常见原因包括：
            </p>
            <ul>
              <li>agent-container-hub 需要 Docker 或 Podman，但本机未安装或未启动</li>
              <li>某些服务依赖其他内置服务先完成安装</li>
            </ul>
            <p>
              请根据详情卡片中的"前置条件"列表逐项检查并满足依赖。
            </p>
          </>
        ),
      },
      {
        question: "如何重置服务配置？",
        answer: (
          <>
            <p>
              每个服务的安装目录下都有一份 <code>.env.example</code> 配置模板。
              如果你需要重置配置：
            </p>
            <ol>
              <li>在控制中心找到对应服务，打开详情</li>
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
      {
        question: "插件安装后为什么不显示？",
        answer: (
          <>
            <p>请检查以下几点：</p>
            <ul>
              <li>
                插件包 (<code>.tar.gz</code>) 内必须包含有效的{" "}
                <code>manifest.json</code> 文件
              </li>
              <li>
                <code>manifest.json</code> 中的 <code>kind</code> 字段必须为{" "}
                <code>"plugin"</code>
              </li>
              <li>
                确认插件 ID 没有与已安装的插件冲突
              </li>
              <li>
                查看主进程日志确认是否有加载错误
              </li>
            </ul>
          </>
        ),
      },
    ],
  },

  /* ── 内置服务说明 ── */
  {
    id: "builtin-services",
    eyebrow: "Builtin Services",
    title: "内置服务说明",
    items: [
      {
        question: "agent-container-hub — 容器管理服务",
        answer: (
          <>
            <p>
              负责管理智能体运行容器的创建、启停和生命周期。
              它是其他智能体服务的基础设施层。
            </p>
            <ul>
              <li>
                <strong>前置依赖</strong>：需要本机安装并运行 Docker Desktop 或
                Podman
              </li>
              <li>
                <strong>前端模式</strong>：<code>none</code>（无前端，仅在控制中心管理）
              </li>
              <li>
                <strong>关键文件</strong>：二进制位于{" "}
                <code>backend/agent-container-hub</code>，PID 和日志在{" "}
                <code>run/</code> 目录
              </li>
            </ul>
          </>
        ),
      },
      {
        question: "agent-platform — 智能体运行平台",
        answer: (
          <>
            <p>
              提供智能体的调度、编排和运行能力，是智能体功能的核心服务。
            </p>
            <ul>
              <li>
                <strong>前置依赖</strong>：需要 agent-container-hub 先启动
              </li>
              <li>
                <strong>自动注入</strong>：启动时会自动注入 Container Hub 地址、
                <code>SERVER_PORT</code>、<code>AGENT_AUTH_ENABLED=true</code>{" "}
                和本地 RSA 公钥路径
              </li>
              <li>
                <strong>认证</strong>：使用 Desktop 统一管理的 RSA 密钥对进行 JWT 认证
              </li>
            </ul>
          </>
        ),
      },
      {
        question: "zenmind-app-server — ZenMind 应用服务器",
        answer: (
          <>
            <p>
              提供 ZenMind 应用的核心后端能力，包括数据存储和 API 服务。
            </p>
            <ul>
              <li>
                <strong>前端模式</strong>：根据配置可为 <code>embedded</code> 或{" "}
                <code>standalone</code>
              </li>
              <li>
                <strong>独立运行</strong>：不依赖其他内置服务，可独立安装和启动
              </li>
            </ul>
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
                <strong>agent-container-hub</strong>（最先启动，确保 Docker/Podman
                可用）
              </li>
              <li>
                <strong>agent-platform</strong>（依赖 container-hub）
              </li>
              <li>
                <strong>zenmind-app-server</strong>（可独立启动）
              </li>
            </ol>
            <p>
              如果不使用智能体功能，可以只启动 zenmind-app-server。
            </p>
          </>
        ),
      },
    ],
  },

  /* ── 插件开发指南 ── */
  {
    id: "plugin-dev",
    eyebrow: "Plugin Development",
    title: "插件开发指南",
    items: [
      {
        question: "manifest.json 结构说明",
        answer: (
          <>
            <p>
              每个插件必须在根目录包含 <code>manifest.json</code>，核心字段如下：
            </p>
            <pre>
              <code>{`{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "kind": "plugin",
  "description": "插件描述",
  "frontend": {
    "mode": "embedded",
    "distDir": "frontend/dist"
  },
  "scripts": {
    "start": "start.sh",
    "stop": "stop.sh"
  },
  "configFiles": [
    {
      "key": "env",
      "label": "环境配置",
      "relativePath": ".env",
      "required": true
    }
  ]
}`}</code>
            </pre>
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
        question: "生命周期脚本",
        answer: (
          <>
            <p>插件通过 Shell 脚本管理生命周期：</p>
            <ul>
              <li>
                <strong><code>start.sh</code></strong>：启动服务进程
              </li>
              <li>
                <strong><code>stop.sh</code></strong>：停止服务进程
              </li>
            </ul>
            <p>
              脚本支持 <code>string</code> 或 <code>string[]</code> 两种写法。
              Windows 上的 <code>.ps1</code> 脚本会自动通过{" "}
              <code>powershell</code> 执行。
            </p>
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
                将插件目录打包为 <code>.tar.gz</code> 文件：
                <pre>
                  <code>tar -czf my-plugin.tar.gz -C /path/to my-plugin/</code>
                </pre>
              </li>
              <li>在控制中心点击"安装插件"按钮，选择打包好的文件</li>
              <li>安装完成后，插件会立即出现在控制中心的服务列表中</li>
            </ol>
          </>
        ),
      },
      {
        question: "认证桥接 (Token Bridge)",
        answer: (
          <>
            <p>
              需要认证的插件可通过 postMessage Token Bridge 与 Desktop 通信，
              获取 JWT 令牌：
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

  /* ── 日志排查 ── */
  {
    id: "troubleshooting",
    eyebrow: "Troubleshooting",
    title: "日志排查",
    items: [
      {
        question: "日志文件在哪里？",
        answer: (
          <>
            <p>
              每个服务的日志路径可在控制中心详情卡片中查看。通常位于服务安装目录下：
            </p>
            <ul>
              <li>
                <strong>标准输出日志</strong>：<code>run/stdout.log</code> 或服务自定义路径
              </li>
              <li>
                <strong>错误日志</strong>：<code>run/stderr.log</code> 或服务自定义路径
              </li>
              <li>
                agent-container-hub 的日志在 <code>run/</code> 目录下
              </li>
            </ul>
            <p>
              你也可以通过控制中心的"日志"标签页直接查看日志内容。
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
                <strong>EADDRINUSE</strong>：端口已被占用，参考 FAQ 中的端口排查方法
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
            <p>
              服务启动后会在运行目录写入 PID 文件，用于跟踪进程状态。
            </p>
            <ul>
              <li>
                PID 文件路径可在详情卡片的健康信息中查看
              </li>
              <li>
                如果服务异常退出，PID 文件可能残留。此时重启服务会自动清理
              </li>
              <li>
                应用退出时（<code>before-quit</code>）会自动停止本次会话启动过的所有服务
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
              <li>ZenMind Desktop 版本号</li>
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
    eyebrow: "Shortcuts",
    title: "快捷键说明",
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
                <strong>控制中心</strong>：管理所有服务的启停和配置
              </li>
              <li>
                <strong>插件市场</strong>：浏览和安装插件（即将推出）
              </li>
              <li>
                <strong>帮助</strong>：当前页面
              </li>
            </ul>
          </>
        ),
      },
    ],
  },
];

/* ================================================================
 *  组件
 * ================================================================ */

/** 手风琴内容高度兜底值（px），用于 scrollHeight 不可用时 */
const ACCORDION_FALLBACK_HEIGHT = 800;

export function HelpPage() {
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const [activeSection, setActiveSection] = useState(HELP_SECTIONS[0].id);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const bodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const isScrollingRef = useRef(false);

  /* ── 手风琴展开/折叠 ── */
  const toggleItem = useCallback((key: string) => {
    setOpenItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /* ── IntersectionObserver 自动高亮导航 ── */
  useEffect(() => {
    const els = Array.from(sectionRefs.current.values());
    if (els.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (isScrollingRef.current) return;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0 },
    );

    for (const el of els) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /* ── 导航点击 ── */
  const scrollTo = useCallback((sectionId: string) => {
    setActiveSection(sectionId);
    isScrollingRef.current = true;
    document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth" });
    setTimeout(() => {
      isScrollingRef.current = false;
    }, 800);
  }, []);

  return (
    <section className="help-page">
      {/* 页头 */}
      <div className="page-head">
        <div>
          <p className="eyebrow">Help Center</p>
          <h1>帮助中心</h1>
          <p className="page-copy">
            安装指导、服务说明、插件开发、日志排查与常见问题，一站查阅。
          </p>
        </div>
      </div>

      {/* 主体双栏 */}
      <div className="help-shell">
        {/* 左侧导航 */}
        <aside className="help-sider">
          <nav className="help-nav-list">
            {HELP_SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`help-nav-item${activeSection === s.id ? " is-active" : ""}`}
                onClick={() => scrollTo(s.id)}
              >
                {s.title}
              </button>
            ))}
          </nav>
        </aside>

        {/* 右侧内容 */}
        <div className="help-content">
          {HELP_SECTIONS.map((section) => (
            <div
              key={section.id}
              id={section.id}
              className="help-section"
              ref={(el) => {
                if (el) sectionRefs.current.set(section.id, el);
                else sectionRefs.current.delete(section.id);
              }}
            >
              <p className="eyebrow">{section.eyebrow}</p>
              <h2>{section.title}</h2>

              <div className="accordion-list">
                {section.items.map((item, idx) => {
                  const key = `${section.id}-${idx}`;
                  const isOpen = openItems.has(key);
                  return (
                    <div
                      key={key}
                      className={`accordion-item${isOpen ? " is-open" : ""}`}
                    >
                      <button
                        className="accordion-trigger"
                        onClick={() => toggleItem(key)}
                        aria-expanded={isOpen}
                      >
                        {item.question}
                        <span className="accordion-chevron">&#x25B8;</span>
                      </button>
                      <div
                        className="accordion-body"
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
                        <div className="accordion-body-inner">{item.answer}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

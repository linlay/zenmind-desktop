import { useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useServices } from "../services/ServicesContext";
import "./PluginMarketPage.css";

type MarketTab = "plugins" | "skills";
type SkillGroup = "推荐" | "系统" | "个人";

type CloudSkill = {
  id: string;
  name: string;
  description: string;
  group: SkillGroup;
  iconLabel: string;
  iconClassName: string;
};

type UploadedSkill = {
  id: string;
  name: string;
  description: string;
};

const PLUGIN_ORDER = ["Container Hub", "智能体平台", "小宅助理", "认证服务"];

const CLOUD_SKILLS: CloudSkill[] = [
  {
    id: "sora",
    name: "视频生成助手（Sora）",
    description: "生成、扩展和管理 Sora 工作流。",
    group: "推荐",
    iconLabel: "S",
    iconClassName: "market-icon-sora"
  },
  {
    id: "doc",
    name: "文档助手",
    description: "编辑、总结并审阅 docx / markdown 文档内容。",
    group: "推荐",
    iconLabel: "Doc",
    iconClassName: "market-icon-doc"
  },
  {
    id: "spreadsheet",
    name: "表格助手",
    description: "创建、编辑和分析表格，适合数据整理与对账。",
    group: "推荐",
    iconLabel: "表",
    iconClassName: "market-icon-sheet"
  },
  {
    id: "playwright",
    name: "浏览器自动化（Playwright）",
    description: "自动化真实浏览器，用于测试和页面验证。",
    group: "推荐",
    iconLabel: "P",
    iconClassName: "market-icon-playwright"
  },
  {
    id: "image-gen",
    name: "图片生成（Image Gen）",
    description: "生成或编辑图片资源，适合设计稿和素材制作。",
    group: "系统",
    iconLabel: "IG",
    iconClassName: "market-icon-image"
  },
  {
    id: "openai-docs",
    name: "官方文档（OpenAI）",
    description: "检索 OpenAI 官方文档、模型与接入说明。",
    group: "系统",
    iconLabel: "OA",
    iconClassName: "market-icon-openai"
  },
  {
    id: "plugin-creator",
    name: "插件创建器",
    description: "快速创建插件目录、清单和市场条目。",
    group: "系统",
    iconLabel: "PC",
    iconClassName: "market-icon-creator"
  },
  {
    id: "skill-creator",
    name: "技能创建器",
    description: "创建或更新技能，适合沉淀团队规范与工作流。",
    group: "系统",
    iconLabel: "SC",
    iconClassName: "market-icon-creator"
  },
  {
    id: "skill-installer",
    name: "技能安装器",
    description: "从本地包或远端仓库安装技能。",
    group: "系统",
    iconLabel: "SI",
    iconClassName: "market-icon-installer"
  },
  {
    id: "figma",
    name: "设计联动（Figma）",
    description: "通过 Figma MCP 做设计到代码的联动工作流。",
    group: "个人",
    iconLabel: "F",
    iconClassName: "market-icon-figma"
  },
  {
    id: "ant-design",
    name: "组件指南（Ant Design）",
    description: "Ant Design 组件、主题和 AI 场景的使用指南。",
    group: "个人",
    iconLabel: "AD",
    iconClassName: "market-icon-ant"
  },
  {
    id: "pdf",
    name: "PDF 助手",
    description: "创建、编辑和审阅 PDF，并保持版式感知。",
    group: "个人",
    iconLabel: "PDF",
    iconClassName: "market-icon-pdf"
  }
];

const GROUP_ORDER: SkillGroup[] = ["推荐", "系统", "个人"];

export function PluginMarketPage() {
  const navigate = useNavigate();
  const { services } = useServices();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [activeTab, setActiveTab] = useState<MarketTab>("plugins");
  const [pluginQuery, setPluginQuery] = useState("");
  const [skillQuery, setSkillQuery] = useState("");
  const [skillScope, setSkillScope] = useState<"全部" | "云端" | "本地">("全部");
  const [feedback, setFeedback] = useState("");
  const [uploadedSkills, setUploadedSkills] = useState<UploadedSkill[]>([]);
  const [downloadedSkillIds, setDownloadedSkillIds] = useState<string[]>([
    "image-gen",
    "openai-docs",
    "plugin-creator",
    "skill-creator",
    "skill-installer"
  ]);

  const marketPlugins = useMemo(() => {
    const nameMap = new Map(services.map((service) => [service.name, service]));
    return PLUGIN_ORDER.map((name) => nameMap.get(name)).filter(Boolean);
  }, [services]);

  const filteredPlugins = useMemo(() => {
    const normalized = pluginQuery.trim().toLowerCase();
    if (!normalized) {
      return marketPlugins;
    }
    return marketPlugins.filter((service) =>
      `${service.name} ${service.description}`.toLowerCase().includes(normalized)
    );
  }, [marketPlugins, pluginQuery]);

  const groupedSkills = useMemo(() => {
    const normalized = skillQuery.trim().toLowerCase();

    const cloudSkills = CLOUD_SKILLS.filter((skill) => {
      if (skillScope === "本地") {
        return false;
      }
      if (!normalized) {
        return true;
      }
      return `${skill.name} ${skill.description}`.toLowerCase().includes(normalized);
    });

    const localSkills = uploadedSkills.filter((skill) => {
      if (skillScope === "云端") {
        return false;
      }
      if (!normalized) {
        return true;
      }
      return `${skill.name} ${skill.description}`.toLowerCase().includes(normalized);
    });

    return GROUP_ORDER.map((group) => ({
      title: group,
      cloudSkills: cloudSkills.filter((skill) => skill.group === group),
      localSkills: group === "个人" ? localSkills : []
    })).filter((group) => group.cloudSkills.length > 0 || group.localSkills.length > 0);
  }, [skillQuery, skillScope, uploadedSkills]);

  function openLocalPicker() {
    fileInputRef.current?.click();
  }

  function handleSkillFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) {
      return;
    }

    const nextItems = files.map((file) => ({
      id: `${file.name}-${file.lastModified}`,
      name: file.name.replace(/\.(zip|tar\.gz|skill|md)$/i, ""),
      description: `本地导入，来源文件：${file.name}`
    }));

    setUploadedSkills((current) => {
      const existing = new Set(current.map((item) => item.id));
      return [...current, ...nextItems.filter((item) => !existing.has(item.id))];
    });
    setFeedback(`已导入 ${files.length} 个本地 skill 文件`);
    event.target.value = "";
  }

  function handleDownloadSkill(skill: CloudSkill) {
    setDownloadedSkillIds((current) =>
      current.includes(skill.id) ? current : [...current, skill.id]
    );
    setFeedback(`已从云端下载 skill：${skill.name}`);
  }

  return (
    <section className="market-page">
      <div className="market-shell">
        <div className="market-topbar">
          <div className="market-tabs" role="tablist" aria-label="市场页签">
            <button
              type="button"
              className={activeTab === "plugins" ? "market-tab is-active" : "market-tab"}
              onClick={() => {
                setActiveTab("plugins");
                setFeedback("");
              }}
            >
              插件
            </button>
            <button
              type="button"
              className={activeTab === "skills" ? "market-tab is-active" : "market-tab"}
              onClick={() => {
                setActiveTab("skills");
                setFeedback("");
              }}
            >
              技能
            </button>
          </div>

          <div className="market-toolbar">
            <button type="button" className="market-toolbar-btn" onClick={() => navigate("/control-center")}>
              管理
            </button>
            <button
              type="button"
              className="market-toolbar-btn market-toolbar-btn-primary"
              onClick={activeTab === "plugins" ? () => navigate("/control-center") : openLocalPicker}
            >
              {activeTab === "plugins" ? "查看服务" : "本地导入"}
            </button>
            <button type="button" className="market-toolbar-icon" aria-label="更多操作">
              <span />
              <span />
              <span />
            </button>
          </div>
        </div>

        <div className="market-body">
          <header className="market-hero">
            <h1>{activeTab === "plugins" ? "插件市场" : "技能市场"}</h1>
            <p>
              {activeTab === "plugins"
                ? "集中展示当前桌面可用的核心插件入口。"
                : "支持从本地上传技能包，或从云端技能库下载到当前环境。"}
            </p>
          </header>

          {feedback ? <div className="market-feedback">{feedback}</div> : null}

          {activeTab === "plugins" ? (
            <div className="market-content">
              <div className="market-filter-bar market-filter-bar-single">
                <label className="market-search">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="11" cy="11" r="6.5" />
                    <path d="M16 16l4 4" />
                  </svg>
                  <input
                    value={pluginQuery}
                    onChange={(event) => setPluginQuery(event.target.value)}
                    placeholder="搜索插件"
                  />
                </label>
              </div>

              <div className="market-plugin-panel">
                {filteredPlugins.map((plugin) => (
                  <article
                    key={plugin.id}
                    className={`market-plugin-feature${plugin.name === "Container Hub" ? " is-active" : ""}`}
                    onClick={() => navigate(`/plugin/${plugin.id}`)}
                  >
                    <div className="market-plugin-feature-head">
                      <h2>{plugin.name}</h2>
                      <span className="market-plugin-status-dot" aria-hidden="true" />
                    </div>
                    <p>{plugin.description}</p>
                  </article>
                ))}
              </div>
            </div>
          ) : (
            <div className="market-content">
              <div className="market-filter-bar">
                <label className="market-search">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="11" cy="11" r="6.5" />
                    <path d="M16 16l4 4" />
                  </svg>
                  <input
                    value={skillQuery}
                    onChange={(event) => setSkillQuery(event.target.value)}
                    placeholder="搜索技能"
                  />
                </label>

                <label className="market-select">
                  <select value={skillScope} onChange={(event) => setSkillScope(event.target.value as "全部" | "云端" | "本地")}>
                    <option value="全部">全部</option>
                    <option value="云端">云端</option>
                    <option value="本地">本地</option>
                  </select>
                </label>
              </div>

              <div className="market-skill-actions">
                <section className="market-skill-action-card">
                  <div>
                    <p className="eyebrow">本地上传</p>
                    <h2>从本地导入技能</h2>
                    <p>支持 `.zip`、`.tar.gz`、`.skill` 和 `SKILL.md` 文件。</p>
                  </div>
                  <button type="button" className="market-toolbar-btn market-toolbar-btn-primary" onClick={openLocalPicker}>
                    选择文件
                  </button>
                </section>

                <section className="market-skill-action-card">
                  <div>
                    <p className="eyebrow">云端下载</p>
                    <h2>从云端技能库下载</h2>
                    <p>按推荐、系统和个人分类浏览，点击右侧按钮即可下载。</p>
                  </div>
                  <button type="button" className="market-toolbar-btn" onClick={() => setSkillScope("云端")}>
                    浏览云端
                  </button>
                </section>
              </div>

              <div className="market-skill-groups">
                {groupedSkills.map((group) => (
                  <section key={group.title} className="market-group">
                    <div className="market-group-head">
                      <h2>{group.title}</h2>
                    </div>

                    <div className="market-skill-grid">
                      {group.cloudSkills.map((skill) => {
                        const downloaded = downloadedSkillIds.includes(skill.id);
                        return (
                          <article key={skill.id} className="market-skill-card">
                            <div className={`market-skill-icon ${skill.iconClassName}`} aria-hidden="true">
                              {skill.iconLabel}
                            </div>
                            <div className="market-skill-copy">
                              <div className="market-skill-title-row">
                                <h3>{skill.name}</h3>
                                {downloaded ? <span className="market-badge">已下载</span> : null}
                              </div>
                              <p>{skill.description}</p>
                            </div>
                            <button
                              type="button"
                              className="market-skill-action"
                              onClick={() => handleDownloadSkill(skill)}
                              aria-label={downloaded ? `${skill.name} 已下载` : `下载 ${skill.name}`}
                            >
                              {downloaded ? "✓" : "+"}
                            </button>
                          </article>
                        );
                      })}

                      {group.localSkills.map((skill) => (
                        <article key={skill.id} className="market-skill-card market-skill-card-local">
                          <div className="market-skill-icon market-icon-local" aria-hidden="true">
                            本
                          </div>
                          <div className="market-skill-copy">
                            <div className="market-skill-title-row">
                              <h3>{skill.name}</h3>
                              <span className="market-badge market-badge-local">本地</span>
                            </div>
                            <p>{skill.description}</p>
                          </div>
                          <span className="market-skill-action market-skill-action-static">✓</span>
                        </article>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          className="market-hidden-input"
          accept=".zip,.tar.gz,.skill,.md"
          multiple
          onChange={handleSkillFileChange}
        />
      </div>
    </section>
  );
}

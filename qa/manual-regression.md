# Desktop 手工回归清单

## 网站 Copilot 选择

- 在 macOS 与 Windows 分别打开侧栏“新增内嵌网站”和设置中的“内嵌网站”，确认“站点 Copilot”的可选 Agent 与顺序一致，均使用 Platform Copilot 列表，不混入仅存在于普通聊天或项目列表中的 Agent。
- 变更 Platform 的 Copilot 列表后重新打开新增弹窗或进入网站设置，确认两处都更新为同一份列表；列表为空时仍可选择“默认 Copilot”。
- 打开已绑定到列表外 Agent 的网站设置，确认保留原 agentKey 并显示不可用提示，未主动修改时保存不改变绑定；切换到有效 Copilot 或默认值后保存，重新进入确认回填正确。

## 连接器内嵌授权

- 自动冒烟：完成 `npm run build:main:prepared` 后运行 `node_modules/.bin/electron qa/connector-auth-browser-smoke.cjs`，使用本地 Platform 夹具和模拟 HTTPS 页面验证真实 WebView、无 Node/宿主桥权限及关闭回传；输出截图路径。它不替代真实企业微信扫码回归。

- macOS / Windows 分别从连接器中心和聊天连接器选择器发起 WeCom 登录：只出现 Desktop 模态 WebView，不启动系统浏览器；Standalone 对应入口出现模态 iframe。
- 授权等待轮询不重复弹窗，后台状态观察不自动打开弹窗；成功由 Platform 状态确认后关闭并刷新连接状态。多步 URL 更新保留同一临时浏览器 session。
- 关闭弹窗取消当前会话；过期后重试生成新会话，迟到的旧关闭请求不能取消新会话。切换页面或卸载观察器关闭展示但不删除凭据。
- 断网、授权页拒绝 iframe、宿主 bridge 缺失和授权失败均提供可读错误或重试说明，不自动转系统浏览器。实际扫码与授权页嵌入策略需使用真实 WeCom 账号验证。
- 无 `auth_browser` 或显式 `system` 的其他连接器保持原有外部链接方式；Desktop SSO 登录流程保持独立。

- 网站空态背景：macOS / Windows 的浅色与深色皮肤中，关闭全部网站进入“暂无打开的网站或网站应用”，有图片时主区保留 55% 不透明底色，背景可见且文字清晰；默认无图片外观保持原样。打开网站或 WebApp 后恢复对应页面的背景策略。

## Windows / macOS 性能采集

- 按 [性能对照流程](windows-performance.md) 验证启用/关闭采集、长 Chat 冷开、往返与快速切换、面板隐藏与关闭；确认路由正常、日志不含 URL/正文，关闭采集后不再追加性能日志。
- 首装后智能体/会话加载失败：按 [首装加载诊断](windows-performance.md#首装加载诊断默认开启) 在 Windows 新环境复现，并在 macOS 对照；确认慢请求记录阶段和最终结果，退出/切换关闭会话后不残留诊断定时器，快速成功请求不刷日志。
- 两平台分别核对进程内存趋势、guest 数和实际销毁事件。路由 APPLIED 不作为业务内容已上屏的判定。

## 程序数据启动清理

- Windows 升级或缺少程序根 VERSION 时，Electron 持有 lockfile 不应使清理失败；main.log 的 `[program-data-cleanup] result` 应记录版本与清理结果。同版本再次启动应为 skipped，服务包未变化时不重复解包；配置、用户数据与插件保持。
- 真正的服务程序清理失败时记录失败路径，不提交新 VERSION；解决占用后可重试。macOS 验证升级清理和同版本跳过保持原行为。

## 主窗口外观基础

- Windows / macOS 分别在浅色、深色及图片皮肤下往返切换 Chat、Website 和 Kanban：侧栏整体底色保持一致，进入 Kanban 不新增白色衬底或遮罩；macOS 原生透明效果保持。
- 使用支持外观桥的新 WebClient，打开 Main Chat 后切换皮肤、图片和系统明暗：主聊天透出同一张壁纸，Composer、消息、菜单与弹窗保持可读；URL、guest ID、草稿、附件、焦点、滚动和流式输出保持。没有图片时回到实色。
- Copilot、WorkPanel、Kanban 与管理页跟随语义颜色，保留实色阅读面；普通 Website/Service 不接收外观快照。Standalone 的偏好不能被 Desktop 宿主覆盖。
- 隐藏恢复、手动刷新 guest、旧 WebClient 未消费新桥、快照超时和失效后恢复均有可读回退；旧文档和迟到快照不能覆盖当前外观。独立自动入口为 `npm run test:webclient-appearance`，再在两种系统的实际 WebClient Bundle 上联调。

- 在 macOS / Windows 导入山湖示例 ZIP、单层包装目录 ZIP 和无背景纯配色包；导入后原外观保持，选择卡片后配色、明暗背景生效。相同版本重复导入给出明确提示，不创建重复项。
- 点击“导入皮肤”并取消文件选择，以及切换皮肤、导入背景时，保存状态只在皮肤标题旁显示加载图标，不新增底部提示行；保存开始与结束时卡片、背景行和下方设置位置保持稳定，辅助技术仍可读取保存提示。
- 在已有自定义背景时分别勾选/取消“保留我的背景图片”再应用包；切换系统明暗、关闭重启、删除原 ZIP 后仍能使用。删除当前包回到默认皮肤，其他包和用户原图保持完整。
- 在 macOS / Windows 的浅深色与窄窗口下检查已导入皮肤：删除图标位于卡片内部右下角，鼠标悬停或键盘焦点进入卡片时显示，移出后隐藏；版本和作者文字不被遮挡。Tab 可聚焦删除按钮并显示焦点框，Enter 删除对应皮肤且不触发应用皮肤；无悬停能力的设备始终显示删除入口。
- 选择非法清单、缺失图片、脚本/越界路径、损坏或超限 ZIP；当前皮肤和背景保持，按钮重新可操作。制造写入失败后点击“重试”，随后通过“重新读取外观”清除错误并确认与已保存状态一致。
- 开发态保留旧 Desktop 进程后热更新带 ZIP 导入的新设置页：应说明完整退出重启，不能将缺失 IPC 显示成普通保存失败；完整重启后提示消失，选择器可用。

统一自动入口见 [Desktop 外观验收](desktop-appearance.md)，运行 `npm run test:appearance`。

- 在“设置 → 外观”选择默认/雾林（绿）/晴海（蓝）/暮紫（紫），正常桌面宽度下一行四张卡片，窄容器下自动两列；卡片各自显示对应配色，浅色/深色切换后仍可分辨。背景行只显示来源和操作，悬停可查看文件名及导入限制。
- 退出并重启后保持选择；切换系统明暗和语言、修改一般设置后皮肤仍保留，旧 profile 自动使用默认皮肤。读取失败有重试入口，保存失败恢复上次选择。
- 导入 PNG/JPEG（覆盖中文、空格文件名、宽图、竖图和透明图片），重启并删除原图后背景仍可用。更换皮肤保留自定义图片，“默认背景”只移除图片覆盖；取消选择、损坏图片、超限图片和只读目录均不替换旧背景。删除已保存副本后显示可恢复提示并回退皮肤背景。
- 在 macOS/Windows 原生选择器中验证取消、重复导入、应用关闭时仍打开选择器的处理；Windows 近期文档不新增背景导入项。快速切换、导入与主题保存同时发生时，最终 profile、按钮颜色和图片一致，无业务页面或 WebView 重载。自动化入口为 `node qa/desktop-appearance-smoke.mjs`，需先编译 Main。

- macOS 与 Windows 分别切换浅色、深色、跟随系统；侧栏、设置、搜索、菜单与弹窗保持默认布局与明暗可读性，窗口控制、拖拽与双击行为正常。跟随系统时改变系统明暗，Desktop 随之更新；固定浅色/深色时不被系统切换覆盖。
- 将偏好设为跟随系统并在系统深色下重启，确认已有缓存的首屏直接使用深色；主窗口就绪后以 profile 为准。模拟浏览器缓存不可用，应用仍能启动和切换主题。
- 延迟或拒绝主题读取后快速切换主题，确认迟到的旧读取不能恢复旧选择，读取失败不会把缓存写回 profile。快速连续切换后重启，最终选择保持；模拟保存失败，回到最近成功的主题并显示失败提示，重试可正常保存。
- 打开 Chat、WorkPanel 或网站后通过设置与 `desktop.theme.get/set` 操作主题，确认两种入口返回/展示的偏好一致，原有页面、草稿、Chat 和 WebView 实例继续保留。
- 分别打开桌宠、日志、动作工作台和实时诊断窗口，确认未附带主窗口皮肤标记；关闭/重建主界面后没有重复系统主题监听或残留的皮肤变量。
- 在仓库根目录运行 `node qa/desktop-appearance-smoke.mjs`，验证浅色、深色、临时配色的原生/Ant 按钮普通、悬停、按下与禁用状态，以及导航选中、输入框、圆角、body Popover、Select 与 Modal；检查终端输出的临时截图。该脚本覆盖两个平台的 CSS 分支，不替代 Windows 真机验证。
- macOS 与 Windows 主窗口分别用键盘 Tab 操作侧栏、窗口栏操作按钮和原生弹窗，确认焦点可见且禁用控件不出现可点击反馈；窗口关闭按钮保持平台系统危险色。打开 HTML 文档刷新确认与 WorkPanel 文件操作失败弹窗，确认继承当前主题。
- 使用上述脚本输出的交互皮肤预览，分别检查默认与雾林的浅/深色、侧栏展开/收起、窄窗口和内容滚动；背景始终铺满窗口且不随内容滚动，按钮可点击，Windows 系统栏保留安全区，macOS 默认皮肤保持原有透明效果。图片加载失败只退到底色，切回有效背景后恢复；切回默认皮肤后无残留配色或背景。
- 在 Electron 背景检查中验证同一 WebView 的 webContents ID 与文档实例标识在皮肤切换后不变，guest 底色保持独立。CSS 平台模拟不替代 Windows/macOS 真机的窗口合成、原生 traffic lights、全屏和拖拽验证。

## 市场技能与置顶联动

- macOS 与 Windows 分别检查技能、连接器、网站应用三个页签，以及中英文、窄窗口布局；技能和技能包卡片尺寸一致，技能包保持堆叠外观但顶部没有额外边框。头像优先使用市场图标，缺失时使用稳定的彩色回退图标。
- 精选只出现市场明确标记的条目；无精选时显示空态，不按下载量补选。点击“换一换”轮换条目；技能/技能包和分类切换、搜索结果均正确。
- 分别打开普通技能与技能包详情，确认技能原文、子技能、版本与安装状态正确；关闭弹窗保留原列表和筛选。已安装技能的“使用技能提问”只选中具体技能并预填新会话，不自动发送；技能包必须选择子技能。
- 在“我安装的”置顶两个技能，再打开 WebClient `/` 菜单，确认技能分组顶部顺序与市场置顶一致；取消置顶后重新打开菜单验证。反向在 WebClient 修改置顶，返回市场并刷新或重新聚焦后确认同步。分别测试重启与服务暂不可用，失败应提示且可重试。
- 置顶技能包后，菜单展示具体子技能而不是包 ID；取消任一子技能的置顶后，包卡片不再显示全部已置顶。包操作中途失败时以服务端实际成功状态为准，不显示虚假全部成功。
- 本地导入、云端已安装与可更新技能均出现在“我安装的”；批量卸载必须先确认，取消不修改安装，部分失败保留失败条目。不出现全局技能启用/停用开关。

## WebClient 调试与网站菜单入口

- macOS 与 Windows 分别在运行配置中启用 `DEBUG_PANEL_ENABLED=true` 并刷新 Agent Chat，确认顶栏显示 Debug 按钮；关闭或未设置该开关时隐藏。已有 Chat 点击后在宿主 WorkPanel 打开对应 Debug item，重复点击复用已有 item；未建立 Chat 时不发起打开请求，宿主 WorkPanel 显隐按钮保持原有行为。
- 同时启用 `SETTINGS_MENU_ENABLED=true`、`QUICK_ACTIONS_ENABLED=true`，确认 `DESKTOP_APP=true` 的 WebClient 根页面、Agent Chat 与 Copilot 均不显示 Settings Menu 或 Quick Actions；Standalone 网站仍按各自开关显示。

## Provider API Key 登记与系统代理

- macOS 与 Windows 分别在隔离的新运行环境中启用系统 HTTP 代理或 PAC，不设置终端代理环境变量，使用空 Provider key 和测试 grant 启动；确认登记请求经过系统选择的代理，成功写入 key 并清理一次性登记文件。关闭系统代理后，可直连的测试接口仍能登记。
- 在 Electron 默认 session 预置登记域名的测试 Cookie，确认登记请求只发送 grant Authorization，不发送 Cookie；登记不会改变既有浏览器 Cookie。
- 使用不可达代理或断网重试，确认错误包含 Chromium 网络错误或底层错误码，Provider key 和登记材料保持原样；错误和日志不含 grant、JWT 或 API Key，单次登记失败不会自动重发申请。
- 分别模拟 HTTP 401 和额度拒绝响应，确认仍显示 HTTP 状态及脱敏摘要，可与连接失败区分；恢复网络后通过用户重试完成登记。

## 多显示器截图

- Windows 与 macOS 分别连接笔记本屏和外接大屏，将 Desktop 移到外接屏后点击区域截图，确认遮罩覆盖该屏四角、提示位于该屏顶部中央，并能在超出笔记本屏尺寸的右下区域框选和得到正确内容。
- 应用在外接屏、鼠标留在笔记本屏时通过键盘触发截图，确认仍选择应用所在屏幕；移动应用回笔记本后再次截图，范围随应用更新。窗口跨屏时以相交面积较大的屏幕为准。
- 覆盖外接屏在左侧/上方的负坐标布局，以及 Windows 100%/125%/150%/200%、macOS Retina 混合缩放；遮罩不缩小或偏移，裁剪不串屏。整屏截图也跟随应用所在屏幕，应用窗口截图仅捕获应用内容。
- 右键与 Esc 均取消且不生成附件；macOS Dock 图标保持可见，菜单栏、Dock 区域和全屏工作区的框选行为正常。

## Connectors Center 导航

- 切换中英文，确认账号菜单、能力侧栏和全局搜索统一显示“连接器中心 / Connectors Center”；从三个入口打开时，Desktop 路由和 WebClient 嵌入地址均为 `/connectors`。
- 在连接器页面进入详情并刷新，确认 `/connectors/:connectorId` 正常加载。macOS 使用搜索面板内 `Cmd+M`、Windows 使用 `Ctrl+M`，确认均打开连接器中心。

## Darwin builtin 签名完整性

- 用新的 Platform release 分别执行不签名同步、预签名同步、已有资源重复签名，确认 Platform 的独立打包校验命令均通过，单文件与连接器/Poppler 目录树哈希和当前文件一致。
- 对原包测试副本篡改 builtin 文件，确认同步/签名前失败；对最终 App 测试副本篡改 builtin 文件或技能，确认发布验证失败，不通过刷新清单掩盖坏输入。
- 正式 macOS 打包确认服务先签名并更新清单，外层 App 签名不再次修改服务文件；最终服务签名、builtin 清单以及开发/安装启动均通过。同版本重新签名后，资源指纹变化能触发重新安装。
- Windows/Linux 不执行 Darwin 清单刷新；Windows 原生服务启动及原始 builtin 清单验证保持通过。

## 品牌应用与托盘图标

- Windows 开发模式分别以 `BRAND=zenmind` 和 `BRAND=cutej` 启动，确认任务栏使用当前品牌生成的 ICO，不受已安装旧版本、开始菜单快捷方式或图标缓存影响。
- Windows 分别让同品牌正式安装版与开发版同时运行，确认正式版使用品牌正式 AppUserModelID、开发版使用其 `.dev` 身份，并显示为两个独立任务栏分组；ZenMind 与 CuteJ 之间也不得互相分组。
- Windows 开发模式和安装包分别检查主托盘区与溢出面板，确认使用透明品牌 tray 图，图标周围没有应用 ICO 的白色底板或淡色方框。
- macOS 分别检查两品牌 Dock 和菜单栏图标，确认 Dock 图标尺寸不变，菜单栏仍按 template image 渲染。
- macOS 左键和右键点击菜单栏图标，确认均展开菜单且不会抢先唤起主窗口；Windows 左键恢复窗口、右键展开菜单。两品牌、中英文均确认“最近对话”“新对话”“打开 <品牌>”“退出 <品牌>”显示正确，原有设置和桌宠入口仍可用。
- 准备超过 8 条跨 Chat Agent、项目的对话，确认托盘展示按更新时间倒序的最新 8 条并去重；侧栏改为手动排序后仍按最新展示。新建、重命名、归档、删除后重新展开菜单，确认同步更新；空历史及服务未就绪时显示不可点击的空态，打开和退出仍可用。覆盖长标题、换行、emoji 与 `&`。
- 主窗口隐藏、最小化时选择最近对话，确认恢复窗口并进入对应主对话；连续点击“新对话”每次进入默认 Chat Agent 的独立新对话，不打开侧边助理、不自动发送。点击“打开 <品牌>”保持当前页面，点击“退出 <品牌>”完成既有任务/服务清理后退出。

## 桌宠贴边与点击穿透

- macOS 与 Windows 分别从屏幕中央慢速拖向四边，在距边约 100px、24px、1px 处松手，再拖到边缘和拖回。人物应连续跟随鼠标，松手位置保持，不隔着明显间距突然吸附；点击人物、右键菜单与拖动释放仍正常。
- macOS 覆盖左侧 Dock；多屏覆盖副屏负坐标和不同缩放比例。在靠近左侧时，透明宿主改变宽度不能让人物跳位；跨屏后按目标屏幕边缘约束，重新开启宠物保留松手位置。
- 将宠物覆盖到其他窗口的菜单或设置按钮附近，分别点击人物下方、左右透明留白、动画帧的透明区域以及贴左边后远处的按钮，确认点击到达下方窗口。拖动中经过这些区域不得丢失鼠标捕获。
- 覆盖待机、拖动、向右移动的镜像动画和招牌动作；点击人物可见部分仍打开应用，两个角标分别可点击，角标之间的透明间隔可以穿透；关闭后重新启用宠物，重复以上点击。

## SSO 重启恢复

- Windows / macOS 分别验证系统浏览器与内嵌登录：先在 8080 启动测试服务，登录及退出均使用动态空闲端口，测试服务始终可访问；授权与换票使用同一实际回调地址，内嵌代理的跳转、页面资源和 Referer 不包含固定 8080。`localhost` 的同一动态端口在 `127.0.0.1` 与 `::1` 均可达，显式 IPv4 的 Google 流程保持可用；认证服务白名单允许动态回环端口。
- 登录成功、拒绝授权、浏览器打开失败、取消、等待超过 5 分钟与完全退出应用后，确认两种地址族的监听端口均释放且可重新绑定；登录成功页完整显示并唤回 Desktop，不提供指向已释放端口的返回按钮。反复取消/重登、旧回调迟到不关闭新监听器；OIDC 前端退出回调与内嵌 Cookie 登录完成同样释放端口。
- 分别使用 CuteJ 的显式 Bearer 恢复配置与 ZenMind 的服务端票据配置：CuteJ 即使缺少上游 Cookie，也应通过保存的 token 完成同源换票与身份确认，再写回派生 Cookie；ZenMind 保持原有流程。未配置 Bearer 恢复时，不得自动发送保存的 token。401/403 清理候选，服务临时故障保留候选但不能发布登录状态。
- macOS 与 Windows 分别在登录成功后立即完全退出并重启，确认上游会话有效时自动恢复同一账号并重新换取 token；再次重启仍保持登录。Windows 同时覆盖默认目录与安装器登记的自定义数据根。
- 确认 SSO 使用默认 session，Cookie 直接写入当前品牌的 `state/chromium/Cookies`；Website 与普通 WorkPanel Web 共享该会话，内置 Browser、WebApp、Help 和 Service 不继承。退出登录后立即重启，不能恢复旧账号或 SSO Cookie，其他网站的 Cookie 应保留。
- 旧 `profiles/electron/Partitions` 下的 SSO 存储应在新 Chromium 根不存在时整体迁移为默认 session，保留 Cookie 与网站存储；新 Chromium 根已存在时不得覆盖。
- 上游明确拒绝时保持退出；断网或上游临时故障时保留恢复材料，联网后自动重试，不能直接沿用未经验证的旧 token。
- macOS 首次安装覆盖旧运行根“保留”和“迁移备份”两种选择，确认引导分类正确，迁移后仍可登录并跨重启恢复。

## 主窗口拖动与双击最大化

- macOS 分别在顶部拖动带、侧栏空白和浏览器工具栏空白双击，确认主窗口最大化，再双击还原；原生 traffic lights 和系统全屏继续保持各自行为。
- Windows 顶部系统栏空白 hover 显示移动光标，单击与双击均不改变窗口大小，按住拖动只移动窗口。侧栏空白和浏览器工具栏空白双击仍可最大化/还原，右上角状态图标同步；覆盖不同缩放比例和混合 DPI 显示器。
- 分别拖动后立即点击、先点击再拖动、按住移出后移回、右键、触摸拖动、拖动时失焦或取消，确认不会误触发最大化；松手后窗口不能继续跟随指针。
- 双击按钮、链接、输入框、Chat 行、Project 标题、浏览器标签与地址栏，确认只执行原有业务交互；后台浏览器工具栏不响应。
- 系统全屏、WorkPanel 全屏及其切换期间、搜索或 guest 模态遮罩显示时，双击不得切换主窗口最大化状态。

## Windows 主窗口系统栏

- Windows 顶栏显示文件、编辑、视图、帮助，中英文与浅深色正常；各菜单可通过鼠标、Tab/Enter、方向键打开，Esc 关闭。编辑菜单对当前输入框或 WebView 的选区生效；设置、帮助、关于、缩放和开发者工具可用，关闭与退出沿用确认流程。弹出菜单不拖动窗口，不覆盖右侧窗口按钮；macOS 原生应用菜单不变。

- 在 Kanban、设置和 Agent WebClient 页面确认薄系统栏独立横跨主窗口顶部，侧栏与内容从系统栏下方开始；浅色、深色和最大化状态下均无重叠或跳动。
- Windows 主导航模式下确认搜索、侧栏开关、后退、前进和智能体面板五个按钮紧跟在 Logo 与品牌名后，侧栏顶部不再重复显示；设置与能力目录继续使用各自的二级导航头部。
- CuteJ 品牌确认系统栏只显示 Logo、不显示 `CuteJ` 文字；ZenMind 仍显示 Logo 与品牌名。
- 逐一点击系统栏五个按钮，确认搜索弹层、侧栏展开/收起、历史前进后退及智能体面板行为与迁移前一致；不可用的历史方向和智能体入口保持禁用且不可聚焦。
- 使用真实鼠标分别点击按钮图标中心与空白拖动区：按钮点击不得触发窗口拖动，空白区仍可正常拖动窗口。
- Windows 在 100%、125%、150% 缩放下持续往返拖动系统栏，分别覆盖同屏与混合 DPI 跨屏，确认窗口宽高不随拖动次数累积增长，松手停止；最大化状态拖动不得改变尺寸。macOS 验证原有拖动行为。
- 在主 renderer 与聚焦 webview 中分别按 `Ctrl+Shift+I`，确认都只切换主 renderer 的停靠式 DevTools；按钮始终留在 ZenMind 系统栏。按 `Ctrl+Shift+D` 仍只为当前 focus webview 打开独立 DevTools。
- 点击最小化、最大化/还原，确认状态图标及时更新；分别通过系统栏关闭按钮、`Alt+F4` 和任务栏右键“关闭窗口”触发关闭，确认只显示一个现有的退出确认框，取消后窗口保持显示，确认后完成受管任务与服务清理并真正退出。托盘菜单“退出”仍直接执行安全退出；打开全局搜索或可信 guest 模态层时窗口按钮被遮罩且不可点击。
- macOS 确认仍使用原生 traffic lights，标题栏和全屏行为不变；`Cmd+W` 在 Website 逐个关闭当前 tab，在 Chat 按可见 WorkPanel → 主窗口层级关闭。

## 连接器导入与授权

- macOS / Windows 分别测试连接器安装包校验失败、授权或初始化占用期间安装/删除、仍被 Agent 引用时删除：提示应区分原因和处理建议，“错误详情”可展开查看后端原因与错误码；失败保留安装包或删除前的选中项。重选安装包、重新打开导入弹窗或重试时清除旧详情。错误详情不得显示 token、密码或完整配置响应。

- macOS 与 Windows 分别在连接器中心导入 ZIP，确认成功后关闭导入弹窗并选中新连接器；成功提示在顶部浮层展示约 3 秒后消失，列表和详情不因提示出现或消失而移动。再次导入仍能显示提示，失败或覆盖确认继续保留在导入弹窗内。
- 点击概览和 Agent 连接器选择器中的“打开授权页面”，确认系统默认浏览器打开一次对应地址，Desktop 保留原页面并继续轮询授权状态；真实扫码或账号确认由用户完成，只有服务端确认后才显示已授权。回归 Website/Browser 和 WorkPanel 的新标签、文件下载，确认仍由各自宿主处理。

## 项目侧边栏

- 将默认智能体设为配置 workspaceRoot: "@root" 的通用智能体（如小宅 zenmi），确认 Platform 列表省略 workspaceDir，重启后确认离开 Loading core components 并进入默认对话，Chats 新建对话与默认智能体选择仍可用；macOS 与 Windows 均覆盖，确认根路径不泄漏到项目列表。

- macOS 与 Windows 分别验证 Projects 仅按 workspaceDir 去除空白后是否非空分类：带目录的 REACT/CHAT Agent 显示为项目，无目录的 CODER/KBASE 不显示为项目；目录已删除的 Agent 仍保留项目归属。验证普通项目及非 CODER/KBASE 项目的拖拽保存、刷新顺序与 Git 分支显示。

- 展开“项目”分组，确认标题栏显示“全部展开/全部收起项目”“刷新项目”和“新增项目”；收起外层分组后只保留“新增项目”，重新展开后前两个操作恢复，各项目原有展开状态保持不变，但“查看更多”恢复为首批 5 条。
- 在外层项目分组展开时逐一悬浮“全部展开/全部收起项目”“刷新项目”和“新增项目”，确认每个按钮只显示一份自定义提示，不再同时出现浏览器原生 `title` 提示；外层收起时“新增项目”仍可正常打开创建流程。
- 比较“全部展开/全部收起项目”与相邻刷新、新增图标，确认箭头和分隔线充分占满 16px 图标画布，视觉尺寸与描边重量一致，切换状态时按钮热区和标题栏布局不跳动。

## Website / WebApp 置顶

- macOS 与 Windows 分别在 Website 右键菜单和 WebApp 更多菜单中置顶，确认入口直接显示在看板、自动化之前，不进入对话 Pinned，也不在 Sites 中重复；关闭看板功能或调整主导航顺序后仍位于顶部。
- 展开侧栏，对照 Automations / New chat 检查置顶 Website / WebApp：图标容器统一为 16×16，图标中心、文字起点和行高一致；Website favicon 不因置顶缩放，WebApp SVG 不额外放大。
- 置顶多个网站与 WebApp，确认新置顶在首位，重启后顺序保留；取消置顶按原 Sites 顺序恢复。关闭页面、停止 WebApp 或切换独立窗口不丢失置顶，现有打开、关闭、运行圆点与更多菜单继续可用。
- 展开/收起侧栏，检查中英文、浅深色、长标题、图标和选中态；方向键顺序与视觉一致，Enter 可打开，macOS/Windows 键盘上下文菜单均能取消置顶。置顶失败时保持原列表并提示可重试。

## 对话置顶

- macOS 与 Windows 分别在展开和收起侧栏确认默认顺序为“自动化 → 新建对话 → 置顶 / Pinned → 对话 / Chats”；调整 Chats 导航位置后 Pinned 仍紧邻其上方，键盘焦点顺序与显示顺序一致。
- 在普通、CODER、KBASE 的对话菜单中分别置顶，确认全部进入同一 Pinned，原 Chats/Project 下不再重复；有足够历史时 Chats 始终补满 8 条、每个 Project 补满 5 条，查看更多分别按 8/5 增长到 24/20，新增行焦点不落到置顶项。
- 混合拖动 Pinned 内不同 Agent 的对话，确认保存并跨重启恢复；普通 Chats 原 recent/manual 模式和序列不改变。取消置顶回到原组的排序位置，新置顶在 Pinned 首位，重复设置相同状态不改位置。组间拖放不得迁移记录。
- 覆盖运行中、awaiting 和未读置顶 Chat，收到 Run/已读 Push 后状态及时更新且置顶保持；Project 统计与桌宠不漏计或重复计数。正在刷新时置顶/取消置顶，再快速切换 Chat，最终与 Platform 快照一致。
- 归档和删除置顶 Chat 后侧栏移除记录；恢复归档后为未置顶。历史、托盘和 WorkPanel 仍能按原 owner 打开置顶对话。模拟保存失败，确认原列表可继续导航、错误可见且下次刷新收敛。
- macOS 与 Windows 分别检查中英文、浅深色、窄侧栏 Pinned Popover 和展开侧栏；键盘方向、Enter、上下文菜单与组内拖动行为一致，长对话标题与 Agent 标签无重叠。全部取消后隐藏空组；旧 Platform 无 `pinnedOrder` 时不出现置顶操作。

## 对话侧边栏

- macOS 与 Windows 分别打开对话右键菜单中的“对话信息”和“分享链接”，确认遮罩只压暗页面，侧栏标题、日期和页面正文保持清晰，无发黑或重影；背景模糊仅作用于卡片内部。与“Desktop 综合搜索”打开时的侧栏清晰度对照，覆盖浅深色及弹窗打开、关闭；分享弹窗覆盖未登录提示、加载中与已加载状态，样式验收不创建公开分享链接。

### 对话分享入口与弹窗

- macOS 与 Windows 分别连续打开、关闭 WorkPanel，确认 Main Chat 右上角分享与 WorkPanel 开关按钮的纵向位置保持不变。WorkPanel 开关保持窗口右侧原有定位；分享按钮在关闭时位于开关左侧，打开时跟随 Main Chat 右边界，拖动面板分隔线时不能进入 WorkPanel。Main Chat 被完全收起时隐藏分享按钮，恢复后重新显示；同时覆盖侧栏展开/收起、窗口缩放与 WorkPanel 全屏。
- 从左下角工具菜单进入“分享管理”，确认切换为与“市场”一致的能力二级侧栏；“分享管理”位于“市场”下方、“帮助”上方并保持选中态。没有图片背景时浅深色均使用实色内容底板；图片皮肤和自定义照片下与市场、归档一样能隐约看见同一张壁纸，文字、按钮及详情保持清晰。点击“返回应用”可回到进入前的主工作区。
- 每个分享分组头部右侧显示“打开对话”，点击后通过标准 Desktop 对话路由进入对应详情并正确聚焦；原对话已删除、历史记录缺失或缺少 Agent 身份时按钮显示“原对话不可用”且不可点击，分享链接仍可复制或撤销。
- macOS、Windows × 浅色、深色分别关闭 Tunnel：所有已有对话的右键菜单都不出现“分享对话”；详情页右上角分享图标仍位于 WorkPanel 按钮左侧，呈禁用灰色与 `not-allowed` 光标，鼠标悬浮或键盘聚焦包装层时提示前往“设置 > 隧道”开启。
- 在设置页开启 Tunnel 后无需重启：右键菜单立即出现“分享对话”，顶部图标立即可点击；Tunnel 仅重连或暂时断开时入口不闪烁、不隐藏。关闭开关后两个入口同步恢复隐藏/禁用状态，设置页头部明确显示“开启后支持分享对话”。
- 打开尚未发送消息的新对话：顶部分享图标常驻但禁用，提示“发送首条消息后即可分享对话”；首条消息产生真实 `chatId` 后立即可用。Tunnel 同时关闭时优先提示 Tunnel 开启路径。
- 分别从对话右键菜单和顶部分享图标打开弹窗，确认两者是同一套 720px 平面化弹窗，遮罩、边框、圆角、背景、阴影和 Cmd+K / Cmd+H 一致；窄窗口下正文独立滚动，紧凑标题栏与底部操作区保持可见。
- 打开左下角设置/账号菜单后按 macOS `Cmd+K` 或 Windows `Ctrl+K`，确认菜单关闭、综合搜索获得焦点且当前页面不变；打开分享弹窗后执行相同操作，确认分享弹窗卸载且只保留综合搜索。让账号刷新保持未完成并快速打开搜索或分享，刷新随后成功或失败都不能重新弹出菜单；关闭搜索后旧菜单和分享弹窗均不恢复。
- 回归所有有效期、阅后即焚警告、加载与错误重试、创建、复制反馈、撤销二次确认和当前分享记录；已有列表时刷新失败只显示错误与重试，不夹带旧详情。关闭、遮罩点击、Esc 与键盘焦点行为正确。顶部操作组不遮挡 macOS 拖拽区、Windows 标题栏、WorkPanel 或系统窗口控件。

- macOS 与 Windows 分别在 Chats、Projects 和 Pinned 检查长聊天标题：默认省略，hover 行或键盘聚焦后仅向左缓慢滚动一次，到末尾停住，不反向、不循环；移开且失焦后恢复，再次 hover 或聚焦时重新播放；短标题不滚动。调整侧栏宽度、修改标题、展开窄栏 Popover 后重新判断溢出，状态图标与菜单不被覆盖；开启系统减少动态效果后保持静态省略和原有悬浮详情。
- macOS 与 Windows 分别在 Chats、Projects、Pinned 及窄栏 Popover 检查聊天状态：标题前无未读蓝点或占位；右侧按 awaiting（标签与转圈）、运行中转圈、未读蓝点、时间的优先级互斥显示。覆盖浅深色、长标题、运行结束后未读及已读更新；未读行 hover/键盘聚焦时蓝点让位于更多菜单且标题不跳动，awaiting/运行中沿用状态显示与右键菜单。
- macOS 与 Windows 分别在浅深色、展开和收起侧栏检查滚动条：初始和静止时隐藏，滚轮、触控板、键盘导航引发滚动或拖动滚动条时显示，停止滚动约 0.8 秒后隐藏；仅悬停侧栏不显示，连续滚动不会提前隐藏，显隐时列表宽度和文字位置不跳动。展开侧栏的 nav 不保留原生滚动条宽度或右侧 padding，滚动滑块覆盖在右边缘；拖动滑块后可滚到列表底部，松开约 0.8 秒后隐藏。Chats/Pinned 列表左右 padding 为 6px。
- 展开侧栏检查 aside 左右各 4px 留白，主导航入口行高 30px、行间距 2px；Chat 运行图标、未读蓝点、更多菜单、Project 未读数字及站点状态图标中心纵向对齐。WebApp/Website 选中或保留焦点时仍显示绿点，仅 hover 时由原位置的菜单/关闭按钮替换，移开后恢复。
- macOS 与 Windows 分别在侧栏展开、收起及中英文模式下确认 Automation 下方常驻“新建对话 / New chat”按钮，图标和文字无重叠；默认在 Automation 后；拖拽或 Alt + 上/下方向键可独立调整新建对话位置。鼠标点击或用方向键聚焦后按 Enter/空格，均使用当前默认助手打开独立新对话并聚焦输入区域，不自动发送；切换默认助手后立即生效，默认助手不可用时按钮禁用且方向键跳过。
- macOS 与 Windows 分别在 240px 最窄侧栏和 360px 侧栏检查“对话”：标题与 Projects 左对齐，折叠箭头紧跟文字右侧，方向和 hover/focus 显隐行为均与 Projects 一致；展开时默认助手保留固定紧凑宽度的占位，并与排序/新建按钮一样，仅在标题栏 hover 或 focus-within 时显示。从栏外移入标题、箭头、助手及排序/新建按钮时，各点击区域不移动，移出且焦点离开标题栏后一起隐藏。分别点击箭头和标题只切换展开状态，点击助手只打开选择菜单；用键盘展开、收起和打开/关闭助手菜单，并检查中英文、长助手名及浅深色下无重叠。
- 展开“对话”分组，确认标题栏显示默认助手选择器、排序和“新建对话”；收起外层分组后隐藏默认助手选择器与排序，只保留标题、展开箭头、状态数量和“新建对话”，重新展开后完整操作恢复。
- macOS 与 Windows 分别在 240px 和 360px 侧栏、浅深色及中英文下收起“对话”分组，确认未读/待处理数量紧跟标题后的折叠箭头，不随侧栏变宽移向右侧；同时显示两种数量、hover/focus 和展开/收起时，新建按钮保持靠右，标题点击区域稳定。
- 在对话分组收起状态点击“新建对话”，确认使用当前默认助手直接创建且不自动展开分组；展开状态下悬浮排序与新建按钮时各只显示一份自定义提示，不再叠加浏览器原生 `title` 提示。完整侧边栏收成窄栏后的对话 Popover 仍显示原有完整操作。
- 在全局 Chats 与 Project 内分别聚焦 Chat 行，普通、非长按的 `↑/↓` 只切换当前可见 Chat 且焦点始终留在目标行；目标带 awaiting 或已显示 WorkPanel 时结果相同。按 `Enter` 后才进入 Main Chat，确认 awaiting 的 `↑/↓` 与数字 `1–4` 原样交给 Agent WebClient。
- Chat 行按普通 `←` 时先把焦点移到对应 Chats/Project 父级再收起左栏，收起态父级再次按 `←` 可展开；普通 `→` 依次验证无 workspace 创建 Overview、隐藏态恢复、显示态隐藏，Chat 行焦点全程不变。带 Cmd/Ctrl/Alt/Shift、长按或键盘拖拽时不得切换两侧面板；分组标题的 `←/→`、Home/End、Enter/Space、菜单键与 `Shift+F10` 保持原行为。
- 按 `Enter` 或鼠标点击进入 Main Chat 后，在消息时间线空白处按普通 `←/→`，确认分别切换左侧栏和当前 canonical Chat 的 WorkPanel，且焦点仍在 Main Chat。再分别聚焦 Composer、可编辑内容、按钮、链接、菜单、可聚焦选项、代码编辑器，并覆盖文字选区、Cmd/Ctrl/Alt/Shift、长按、输入法组合、按住指针和拖拽场景，确认方向键不触发宿主面板。Chat 存在 active awaiting/HITL 时，无论焦点位于选项还是其余 Main Chat 区域，`←/→`、`↑/↓` 与数字选择都只由 WebClient 处理；awaiting 结束后空白区宿主左右键恢复。

## WorkPanel 自由新增 Tab

- macOS 与 Windows 分别在 Chat A 打开 Overview，立即切到 Chat B，再切回 A；重复隐藏/显示 WorkPanel、Overview 与普通网页 tab 互切，并覆盖 Overview 尚未加载完成的情况。确认 Overview/Debug 失活时 guest 被回收、激活时创建新 guest 并恢复内容，不残留 `Desktop Platform Frame Port is closed`；普通网页 guest 和文档未保存草稿继续保留，后台 Run 不被中断。

- 在 macOS 与 Windows 分别打开一个稳定 Chat，确认 Overview 固定首项，`+` 图标框为 `16×16px`、四边内留 `2px`，按钮区域为 `24×24px`，默认透明，hover、键盘 focus 或菜单展开时显示底色；按钮在 tab 行内垂直居中，紧跟最后一个 tab 并随横向溢出滚动。切换语言后，新增菜单中文显示“网站应用”、英文显示“WebApp”，空列表提示同步使用对应语言。
- 默认皮肤下，浅色标签栏为 `#FFFFFF`、选中 tab 为 `#EEEEEE`，深色分别为 `#181818` / `#303030`；tab 高度为 `28px`，四角均为 `10px` 圆角，上部留 `8px`、下部留 `4px`，标签栏总高为 `40px`，相邻 tab 与 `+` 间隔 `4px`。在 macOS、Windows、窄面板与全屏下检查底部圆角完整、标签栏不遮挡内容、右上角面板按钮中心比 tab 中心高 `2px`；多 tab 横向滚动、hover、键盘焦点和关闭按钮保持可用，切换皮肤仍消费该皮肤的标签配色。
- 分别把焦点放在侧栏 Chat 行、Main Chat 与当前 WorkPanel WebView，连续按 macOS `Cmd+W` / Windows `Ctrl+W`：先关闭 active 可关闭 tab；Overview 激活时关闭最后一个可关闭 tab；再关闭整个 WorkPanel；下一次才执行主窗口原有关闭。取消 dirty/批注确认或遇到 busy 时本次停止。隐藏 WorkPanel、后台 Website、Browser、Copilot 与其他 Chat 的后台 WorkPanel 不得被误关闭。
- 从侧栏显示/恢复 WorkPanel、切换 Chat 和切换 WorkPanel tab，确认不会自动把焦点送入 WebView；只有用户主动点击 Main Chat、WorkPanel 内容或 tab 时焦点才移动。隐藏、失活和回收 item 后旧 WebView 不再接收按键，macOS 与 Windows 都回归。
- 在浅色、深色、Windows 标题栏偏移和 WorkPanel 全屏下检查菜单定位、圆角、hover/focus、Esc、方向键、Home/End 与 Enter。
- 确认菜单顺序为 Terminal、Web、Files、Side Chat、Project、WebApp；Terminal 禁用且没有快捷键或 PTY。
- Web 输入无协议域名时补 `https://`；拒绝 URL 中的用户名密码和非 HTTP(S) URL。重复 URL 激活已有 tab；Website、普通 WorkPanel Web 与其 popup 共享 Desktop 应用浏览器 Cookie partition，popup 仍留在所属 Chat。分别在登录、刷新 access token、退出登录和 Desktop 重启后验证 `HttpOnly`、`SameSite` 与重定向 Cookie 按 Chromium 原生规则生效；本地文件、WebApp、Help、内置 Browser 和服务页不得继承。
- 激活普通 Web 或 loopback tab 时确认标签栏下只增加一行浏览器工具栏：预览模式显示后退、前进、刷新、可直接输入的地址与“编辑”；进入 HTML 编辑模式后，同一行只保留“返回预览”和元素选择提示，导航/刷新/地址不再与批注操作混用，也不得再出现“完成 + 退出”两个重复出口。Workspace File、Artifact、Reference 和 Desktop 原生静态文档不显示这行浏览器工具栏。
- 从 Main Chat 分别打开 Workspace File、Artifact 与 Reference 来源的 HTML 和图片，确认 Desktop 创建原生 document tab；Markdown、文本、代码、PDF、Office、媒体、压缩包与未知二进制仍由 WebClient Document Surface 承载。Standalone 全部使用 WebClient，不显示 Desktop-only 操作。
- 在 macOS 与 Windows 的 Main Chat 点击指向 workspace 内 README.md 的绝对路径 Markdown 链接，确认 WorkPanel 打开 Markdown 预览；覆盖含空格路径、Windows 盘符与 UNC 路径。workspace 外路径和指向外部文件的符号链接必须拒绝，Desktop Action 本地文件入口仍拒绝绝对路径。
- 用截断或浏览器无法解码但签名仍匹配的图片回归原生预览：WorkPanel 保持可操作，不显示错误条或错误占位文案，编辑入口禁用，其他 tab 与 Main Chat 不受影响。
- 原生图片预览态顶部固定为单行，不直接显示文件名；hover 或键盘 focus 信息按钮时显示完整文件名、格式/大小和源尺寸。验证 10%–800% 比例、缩放、中性背景的编辑入口与打开方式，以及适合窗口、100%、比例直接输入、触控板/Cmd/Ctrl 缩放、拖拽平移、默认/其他应用打开、窄 WorkPanel、拉宽、全屏和窗口 resize；不得出现第二行或横向滚动条。
- 编辑态确认图片工具位于左侧 44px 单列图标栏，hover 后立即在右侧显示工具名，禁用项也能显示。顶部只保留“返回预览”、撤销/重做、缩放与保存；窄 WorkPanel 中仅次要按钮收敛为图标，普通样式的“返回预览”始终显示返回箭头和四字文案，整行无换行、无横向滚动；未修改时保存为普通禁用样式，产生可保存修改后才显示蓝色强调。左栏“变换”hover/focus 后在右侧显示旋转、水平/垂直翻转和自由变换二级菜单；图片尺寸与画布尺寸各自独立，画布尺寸扩大或缩小时原图像素不拉伸。建立矩形、椭圆、套索或画笔选区后启动自由变换，确认原选区像素被提取到可拖动边框，四角可缩放且角度可输入，取消不改图、应用只增加一步历史。批注、按批注修改、对象擦除、背景移除/替换、扩图、增强必须作为连续紫色按钮平铺在“调整”之后，不得再出现机器人总入口、聚合 AI 工具对话框或“选区/批注二选一”的重复入口。验证普通选区只用于自由变换和对象擦除，按批注修改只接受已经圈选且逐条填写要求的批注；批注面板以摘要列表呈现且仅展开当前一条。拖动批注面板标题和其他设置浮层手柄，确认可移开被遮区域且不会拖出画布容器；内容过多时只在浮层内部滚动，图片显示尺寸和适合窗口比例不发生跳变。再验证裁剪、尺寸、曝光/对比度/饱和度、选区添加/减去/反选/清除及 50 步撤销上限。像素修改前有批注时必须确认清除；超出 8192 单边或 4000 万像素时编辑入口禁用。
- 在浅色和深色主题下逐项悬浮并用键盘聚焦图片编辑器按钮：画布尺寸、调整、自由变换、AI 参数、批注与保存弹窗中的主操作始终保持蓝色且文字可见；裁剪确认保持蓝色；普通按钮显示中性反馈；选中工具不丢失 active 底色；紫色 AI 工具不退化为透明背景；禁用按钮不响应 hover。默认窄 WorkPanel、拉宽和全屏下结果一致。
- 验证擦除对象必须有选区，移除/替换背景、扩图和增强每次只产生一个 Zenmi 候选，运行中仍可缩放/平移且可取消；失败不丢草稿，结果不自动写入 Artifact。
- 每次保存都重新选择，弹窗中的取消、覆盖原 Artifact、生成新 Artifact 在同一行等宽排列；Reference 只显示取消与生成新 Artifact。Artifact 默认生成新 Artifact且可覆盖；透明结果不覆盖 JPEG；revision 冲突禁用覆盖。新 Artifact 打开新 tab，覆盖保留原 tab并清空 dirty/undo。
- macOS 验证 `.app`、Windows 验证 `.exe` 的无 shell 外部打开；有草稿时先提示只打开原文件。外部修改在无草稿时自动刷新，有草稿时只允许丢弃重载或另存新 Artifact；远端缓存先下载副本并明确不会回写。
- 在浅色、深色、默认窄 WorkPanel、拉宽与全屏状态检查普通 Web 的分段按钮、地址截断、编辑按钮和键盘 focus；窄宽度仍保留完整编辑入口，地址安全截断且不挤出工具栏。Markdown/TXT/代码不得出现地址栏或第二行宿主工具栏。
- 连续新增两个 Side Chat，确认都导航 `/btw/:chatId` 且 guest/instance 独立；active BTW 可调用 BTW/attach，不能 query；切换、隐藏、关闭不取消后台 Run。
- KBASE 显示可用 Project；CODER 仅在 workspace 有效时可用，并携带当前 chatId 与 lastRunId；普通 Agent 不显示 Project。

## WorkPanel 统一文档 Surface

- macOS 与 Windows 分别打开 DOCX/PPTX/XLSX 元信息页，确认文件图标、名称、易读大小、可截断的 MIME 和操作集中在同一卡片；在线预览、下载、文件定位与默认应用打开按钮等宽、等高。窄 WorkPanel、全屏、浅色/深色及皮肤主题下无横向溢出；未配置预览时保留禁用按钮与原因，宿主定位/打开继续检查可用能力。

- 以显式 title、相对路径、macOS/POSIX 绝对路径、Windows 驱动器路径、UNC 路径、中文/空格、空 basename 和超长名称创建 File descriptor；Tab 标题必须为“显式 title > basename > file”，不 URL decode，且 stable key 和 `surfaceId` 不变。分别使用新旧 WebClient bundle 验证 Desktop 兜底。
- 对 Workspace File、Artifact 和 Reference 遍历 HTML、PNG/JPEG/WebP、动画图、SVG、Markdown、TXT、代码、PDF、Office、音视频、压缩包与未知二进制；Desktop 只原生打开 HTML/图片，其他类型使用 WebClient。伪造扩展名、错误 MIME、Office ZIP、SVG 和无后缀 UTF-8 文本必须以 Platform 最终分类为准。
- 原生 HTML 打开后直接占满 WorkPanel 内容区；header 工具条在预览态同时显示安全语义 URL 与“批注”按钮，不出现“源码/预览/分屏”、源码输入框、覆盖、保存或另存按钮。进入批注后 header 显示“返回预览”、选择提示和实时批注数量；悬停元素必须出现虚线选择框，点击后阻止页面原动作并新增批注，填写要求后可交给智能体。返回预览后页面恢复正常交互。默认窄宽度、拉宽、全屏和窗口 resize 下均不得露出底部空白背景。
- 在 Markdown/TXT/代码中验证 Monaco、查找替换、选区批注和 revision 冲突。Markdown 首开及切换文档后默认显示净化预览，只有“预览 / 源码”两种模式，不出现分屏；在预览中选取文字可添加批注，源码中可直接编辑。点击保存必须先弹出“如何保存”：Workspace 主操作为“保存（覆盖）”且不能新建产物；Artifact 主操作为创建新产物且可选覆盖原产物；Reference 只能创建新产物。外部 revision 变更后批注必须失效而不漂移。
- 发布中文/英文、UTF-8 BOM、空文件的 `.md/.markdown/.mdx/.txt` 产物，确认 Artifact manifest 与 Resource GET/HEAD 通过 `X-Document-Kind` 与 `X-Document-Revision` 返回一致的 Markdown/Text kind 和源 revision，并保持 UTF-8 MIME 与 size，WorkPanel 进入 Monaco。响应缺少 kind 时仍按 provisional 扩展名预览；UTF-16、无效 UTF-8、含 NUL 的文本扩展名文件只显示“文本编码不受支持”和下载入口。
- 确认 Workspace File、Artifact、Reference 文档只显示 Tab 与最多一行文档工具栏；文件名不在内容区重复，完整路径只在 Tab tooltip/右键菜单。Markdown/TXT/代码等 WebClient 文档的更多菜单可重新加载权威 revision，dirty 时先确认丢弃；原生 HTML 仍只提供批注入口。普通 Web 与 loopback 仍显示地址栏和刷新。
- 验证 PDF.js 页码、缩放和搜索；Office、压缩包和未知二进制不显示伪文本也不自动下载。Desktop 的系统打开/定位在 macOS 与 Windows 分别回归，Standalone 不显示这些操作。
- 在有效 Coder owner Chat 打开 `localhost`、一个 `*.localhost`、`127.0.0.1` 和 `[::1]` 站点；元素批注只交接脱敏摘要、selector/XPath、坐标、URL 和可选截图，页面不获得文件系统、Node、Token 或 Desktop API。Coder 修改 workspace 后用 HMR/刷新验证；顶层导航离开 loopback 后交接语义立即退化为普通 Web。
- 分别在原生与 WebClient 文档中制造 dirty、busy 和批注，再关闭当前 Tab、关闭其他 Tab、隐藏/恢复 WorkPanel、切换原生编辑器和进出全屏；未保存保护必须绑定当前可信 item，guest replacement 不得用旧状态阻塞新 Tab。

## WebView 生命周期与全局 Realtime Broker

- 在 Main Chat、Copilot Dock 与 Kanban Chat 的用户/助手消息、Markdown 和代码块中分别拖选单一语义目标，确认 Desktop 工具条出现；跨消息/代码块、输入框、管理页、Website/WebApp 和普通浏览器 WebClient 不出现。抓取 guest/Main/renderer IPC，确认显示与执行 payload 均不包含选中文字。
- 点击“添加到对话”，确认主 Composer 保留原草稿/文件/技能并增加 `N 条注释`，发送前没有 query；点击“在顺便问中提问”，确认右侧 BTW 打开并增加 `N 个已选文本片段`，同样不自动发送。发送受理后片段清空，受理前失败时仍保留。
- 点击“详细解释”，确认单例小窗立即显示准备态，并定位到 CuteJ 主窗口 bounds 内的右下角（macOS 20px、Windows 16px 边距），而不是整个显示器的右下角。只产生一次 `/api/btw`，随后按 `chatId/runId` attach 并支持继续追问、复制与 Stop。重复点击复用窗口并重新对齐主窗口右下角；关闭窗口只 detach，不 interrupt。Realtime Inspector 中辅助 observer 不替换 Main Chat、Copilot Dock 或 Kanban Chat observer，详细解释的首次提问、续问、Stop 与恢复均使用独立 Selection Explain lane，物理连接不超过 Primary + BTW + Selection Explain 三条。
- 在 macOS 与 Windows Desktop 同时启动主聊天、WorkPanel BTW 和详细解释，确认三个 runId 分别在三条 lane 交错输出；停止解释不影响其他两者，关闭解释窗只 detach。分别断开解释与 Primary 连接，检查已接受 Run 仅 attach 恢复、不新增 query、连接不互相顶替；切换账号后旧身份的三条连接均失效。普通网页划词只有添加到对话与旁聊，直接访问解释 URL 也不能启动或订阅解释 Run。
- 详细解释窗口使用自身启动明暗和默认实色外观，不出现 `AppearanceProvider` 或主窗口外观 IPC 权限错误。辅助窗口错误页只允许重新加载或关闭，不在本窗进入控制中心或 AppShell；打开、关闭及重新加载解释窗后，主窗口仍可新建对话并正常发送。主窗口 guest 重挂载期间，辅助窗口也不能登记 `main-chat` 身份。

- 在 Main Chat、Website/Browser 的 Copilot Dock 与 Kanban Chat 之间切换并分别发起对话，确认同一时刻只有当前 surface 持有 live observer；Dock 继续加载内部 `/copilot/:agentKey`，Desktop 不再挂载全页 `copilot-chat`。
- macOS 与 Windows 分别在 Copilot 的同一个运行中 Chat 最小化/恢复窗口、隐藏/重开 Dock，并从历史重新打开该 Chat；恢复后停留原页，确认后续 stream 持续增长。attach 未携带 chatId 且 Dock 未登记 ownerChatId 时，仍须按当前 guest Chat 在 Primary lane 建立 Broker 订阅，不新增物理 WS、不重发 query，也不得作为一次性请求转发。
- macOS 与 Windows 分别固定一个 Main Chat 和一个 WorkPanel WebClient guest，记录 `webContentsId` 后反复切换 Chat、WorkPanel tab、面板显示/隐藏和 active 状态；同一 generation 只能出现一次 `listeners-attached`，普通状态变化不得出现 `listeners-detached`，guest 被替换或卸载时才允许成对解绑。
- 从 Sidebar 依次打开同 Agent 与跨 Agent 的多个历史 Chat，再通过 Cmd+K、新建按钮触发 New Chat 和继续对话；确认 Desktop route、Main Chat guest URL、WebClient Router、页面内容与 Registry owner 一致切换，`webContentsId` 保持不变。暖态历史 Chat 点击后首个可绘制帧应出现骨架，人工或性能标记测得不超过 100ms；快速 `/api/chat` 也完整显示约 160ms，再用约 80ms 渐隐。目标历史 Chat 已有 active Run 时仍显示骨架；同 Chat 后台恢复、New Chat 首次创建和 `newChat → chatId` live promotion 不出现历史切换骨架；加载错误立即显示可重试错误层。地址栏已到目标但 Router 尚未切换时，bridge 仍必须完成 Router replace；正常日志为 `main-chat-router-ready → chat-route-bridge-queued → main-chat-router-applied-received → main-chat-router-applied-accepted`，并包含 `desiredToReadyMs`、`sentToAppliedMs` 与 `totalElapsedMs`，不得出现 retry、timeout、fallback、Main Chat `history.pushState` 或 reload。人为分别阻断 READY 和 APPLIED 时，从 desired route 建立累计 1000ms 后只能记录一次 `main-chat-router-timeout` 并执行一次 `loadURL`；reload 后恢复 status listener，应以相同最新 revision 完成且不得形成 reload 循环。错误 revision、Router location、WebContents/document generation 的 APPLIED 只能 rejected，不能取消 watchdog。在历史 Chat A/B 分别输入未发送草稿，多次切换后必须分别恢复；New Chat 草稿在相同或不同 Agent 返回时仍恢复，发送后才清空。Inspector 中 Primary 物理 WS 全程保持同一条；旧 Chat 有 active Run 时只出现一次 detach，无 active Run 时不产生 detach，切换后的 `/api/chat` 仍在原 LogicalSession/Primary WS 上完成。快速 A→B→C 只展示和加载 C，骨架可连续保持但不能闪回 A/B；Realtime 诊断中每次稳定 Chat 切换只允许一次目标 `chatId` 加载，不得在 surface active 恢复时紧随发出旧 `chatId` 的 `forceReload`。
- 在 macOS 与 Windows 的展开侧栏分别点击全局 Chats 和某个 Project 内的 Chat，确认焦点留在所点行；逐次按 `↑` / `↓` 时只在当前可见 Chat 列表内切换并同步选中态与页面，跳过分组标题、“查看更多”和“查看历史”，首尾不循环，长按不连续切换。按 `Enter` 后焦点进入 Main Chat WebView；键盘拖拽排序期间方向键只用于排序，不触发 Chat 导航。Cmd+K、历史弹窗和新建 Chat 仍在导航后聚焦 Main Chat。
- 从已有 Chat 打开 Cmd+K，分别通过鼠标、Enter、macOS Option+数字与 Windows Alt+数字选择当前 Agent 和其他 Agent；确认每次都进入所选 Agent 的 `/agent/:agentKey?newChat=<13 位 nonce>`，现有 Cmd+K “New Chat” 仍选择当前或默认 Agent。Desktop route、Main Chat guest URL、WebClient Router 与 Registry ownerless identity 必须一致，`webContentsId` 保持不变；立即发送第一条消息时 `/api/query` 只到达 Platform 一次，并正常以 `chat.start/run.start` 将同一 generation 提升为 canonical `chatId`。快速连续选择多个 Agent 时只允许最后一个目标提交，Chat 搜索结果仍打开原 canonical Chat。
- 准备一个不在 WebClient 当前列表缓存中的 unread Chat，分别从 Cmd+K、Sidebar 和桌宠打开。确认目标内容提交显示后只有 WebClient 经 Frame Port 发出一次单 Chat `/api/read`，Desktop 没有 `assistant.markChatRead` IPC、Sidebar fallback 或桌宠直写；Platform 的 `chat.read` 到达前 Sidebar 圆点保持，到达后全局 Chats、Project recentChats、activity 和 Agent 计数同时更新。让 read Push 在 Navigation 刷新旧快照期间到达，确认快照完成后仍为 read；再注入同 Run/旧 Run 的晚到 unread，确认被忽略，而更新 Run 的 unread 能恢复圆点。点击“全部标为已读”时确认 Desktop 只发送 Agent 级请求，UI 等待 `chat.read_all` Push，不做本地乐观清除。
- 处于 `?newChat=` 空白页时通过 WebClient 切换到另一个 Agent；确认 Desktop 只生成一次目标 Agent 的新 nonce，WebClient Router、worker 选择和空白 Timeline 同步切换，旧 Agent 内容不得继续显示。ACK 前宿主目标造成的 guest URL 回声不得再次触发 Agent switch 或持续改写 `newChat=timestamp`；快速连续切换 Agent 时只提交最后一个真实目标，日志中的 `main-chat-route-transition-replaced` 应能明确列出前后 revision/target，不得被物理 URL 相等的判断吞掉。
- 在稳定 Chat A 中首次选择此前未打开过的 Chat B，并在页面尚未完成切换时立即发送 Query、点击 WorkPanel：Registry 应先把 Main Chat 标为 inactive，待 Desktop route、guest URL 与 owner 收敛到 B 后再提交 active B；原 Query 在既有 1500ms 窗口内继续成功，WorkPanel 无需切走再返回即可自动打开。日志中的同一 revision 应能看到 `switching → ready`，不得出现 `Main Chat identity did not converge before query authorization`。
- 在 A→B→C 快速切换期间点击 B 的 WorkPanel 后继续切到 C，确认 B 的迟到导航/注册不能提交，B 的 pending intent 被取消；返回 B 时不得意外自动打开。再 reload Main Chat 或替换 guest generation，确认旧 `webContentsId` 的注册和 pending 同样失效。
- 进入带新 nonce 的 Main Chat 后立即发送第一条消息；确认 Registry 已登记同一 `agentKey + newChat` 的 active ownerless surface，query 不进入 1500ms convergence wait，而是只通过现有 Primary WS 到达 Platform 一次。随后 `chat.start/run.start` 正常把同一 generation 提升为 canonical owner；不得出现 loading 在约 1500ms 后静默结束或 `Main Chat identity did not converge before query authorization`。
- macOS 与 Windows 分别连续执行三轮“New Chat → 发送成功 → New Chat → 再发送”，并覆盖先上传附件预建 Chat 的发送路径。guest 与 Primary WS 保持复用，每次新上下文的 observer token/context epoch 都改变，lease 从 pending 原位提升为 ready；同来源重复登记和 canonical promotion 不更换 token。旧 Chat 的 Overview/Debug 订阅以 detached 结束，旧 Run 继续后台运行且不重复发送 query。快速切换不同 nonce、不同 Agent，并延迟旧 chat.start/run.start 或 canonical 同步 ACK，确认旧帧、旧错误不改变新 Chat；不得出现 `active Main Chat Broker bundle is unavailable`。
- 在 Main Chat guest 尚未 `dom-ready` 时快速触发 A→B→C 三次路由变化，确认只应用 C；过渡期 Registry 可返回 `route_not_aligned`，但不得高频重试、回滚到 A/B 或更换仍存活 guest 的 `webContentsId`。
- 未使用 Side Chat 和详细解释时在 Realtime Inspector 确认 Primary WS 为 1、BTW 与 Selection Explain WS 均为 0；首次 BTW 后变为 1+1+0，首次详细解释后变为 1+1+1。随后并发普通、旁聊和解释 Run，并跨 Chat、WorkPanel 和 BTW tab 切换，确认物理 WS 总数始终不超过 3，RunChannel 数可以独立增加。
- 分别开启和关闭桌宠发送 Main Chat Query，并覆盖 `run.started` Push 早于、晚于 Query `run.start` 两种顺序；两种情况下都只允许一次 `/api/query`。确认桌宠不注册独立 Broker consumer、不单独请求 `/api/agents` 或 `/api/chats`、不消费 Assistant Run 逐事件流，只在 Navigation 应用 `desktop-main` Primary Push 并发布新快照后更新，不得创建 RunChannel、发送 `/api/attach` 或导致 `duplicate_id`。
- 构造 Chats unread=2、pending=1，Projects unread=4、pending=2，确认 Nav Bar 分组数字分别保持该值，桌宠同时显示蓝色 unread=6 与橙色 pending=3；将对应 Chat read、awaiting answered 后，两处必须在同一 Navigation Push 投影后一起减少。折叠/展开 Chats、从 8 条增加到 24 条不改变统计口径；重启及 Primary 断线重连后不得恢复消息缓存或本地持久化中的旧数字。
- 展开桌宠“对话概览”，确认仅显示七天内的 unread 与 awaiting 会话，视窗完整容纳三条并可用滚轮继续浏览；chat name 与正文均为 13px，item 间有清晰的 1px 分割线，unread 为蓝点、awaiting 为橙色时钟且不显示回复入口。关闭按钮默认不占位且仅在 item hover/focus 时叠加出现；关闭只在当前桌宠投影中 dismiss，回复成功只提交新 Run，两者都不得调用 `/api/read`。打开对话只导航到 Main Chat，必须等内容显示后由 WebClient 发 read，并在 Platform `chat.read` Push 到达后让桌宠与 Sidebar 同步转为 read；单纯 hover、滚动和展开列表不得标记已读。
- Main Chat surface 获得可信 active 登记后、任何 live frame 到达前，在 Realtime Inspector 确认 Root Observer 与 Overview lease 已同时存在；未打开 WorkPanel 时不得创建 Overview WebView、UI subscriber 或额外 upstream attach。ownerless 新 Chat 先显示 `pending_chat_identity`，canonical Chat 建立后在同一 context epoch 内变为 `ready`。
- 连续至少 30 次交错 Main Chat surface 登记、Frame Port open、Main attach/query 与 Overview attach，并穿插 A→B→C 快速切换；确认无需重试即可从本地 replay 连续收到事件，不产生 Overview upstream attach，关闭 clone 不产生 detach。正常首开、切换和恢复中不得出现 `Main Chat clone parent was released`、`sender is not a trusted Agent WebClient surface`、`parent_observer_closed: active Main Chat observer is unavailable`，也不得出现 `primary_stream_not_ready` 或其他基于等待时长的错误。
- Main Chat 离开、owner Chat/context 变化、surface generation 替换和 guest 销毁时，确认 Overview/Debug subscriber 同步失效，正常切换的旧 Overview 以本地 `detached` 完成；每个变为无 observer 的非终态 RunChannel 只发送一次 upstream detach，Platform Run 继续执行。返回原 Chat 后从 Inspector 显示的 lastSeq attach，query 不得重发。隐藏、显示或关闭 WorkPanel 只改变 pending/UI subscriber 数，Overview lease 始终由当前 active Main Chat 持有；隐藏的所有 guest 必须保持 mounted 且 inactive。
- 制造 detach/reattach 紧邻交接：detach 尚未写出时新 observer 应取消旧 detach；detach 已写出时新 attach 必须等待响应后从 lastSeq 开始。确认旧 generation 的迟到完成不会覆盖新 observer，且不重新出现 listeners attach/detach 高频抖动。
- 分别断开 Primary、BTW 和 Selection Explain，确认其他 lane 的 Inspector phase 与活动 Run 不被标记为断线；账号、endpoint 或 device identity 变化时三条 lane 一起轮换。Primary 收到旁聊或解释 runId 的 `run.finished` 后能收敛对应 RunChannel。
- 进入 Kanban 前先在其他页面打开 Copilot Dock；进入 `/kanban` 后确认 Dock guest 立即 inactive 并卸载，Launcher、System Bar、程序化 open/toggle 和旧 Kanban session 都不能恢复 Dock。Kanban Chat、claim、run prepare、native run 与事件同步继续正常；离开 Kanban 后其他页面原有 Dock session 可以恢复。
- 打包环境正常操作不得持续写入 attach/detach/navigation debug，开发环境重复 debug 应在 500ms 窗口聚合；Inspector 和日志不得包含 token、Cookie、用户正文或完整业务帧。
- 从设置的调试分类打开“桌面运行时观察器”，确认独立窗口可持续列出所有 Registry Surface、每个已打开 WebView 及未登记 WebView；Surface、WebContents ID、PID、owner、URL（不含查询参数/凭据）和 active/loading/crashed 状态与实际运行一致。
- 在观察器中按 RSS、5 分钟增量和 CPU 排序，确认多个 WebView 共享 renderer PID 时显示同一进程 RSS 并明确标记 shared，不把进程内存伪装成单 WebView 独占内存；macOS 与 Windows 都能持续刷新且冻结后数值停止变化。
- 选择任一存活 WebView 后切换概览、内存、事件和原始数据，确认复制快照不包含 URL query、hash、用户名或密码；“打开 DevTools”只对仍存活的 WebView 可用，guest 销毁后返回不可用而不误开其他页面。
- 切换 Targets、Events、Topology、System，确认Primary/BTW/Selection Explain、Frame Port、Run 恢复和跟踪帧诊断仍可查看；清空只删除有界 trace，不销毁 Surface、WebView 或 Broker 状态。

## 首装引导 Chat

- 准备至少 16 条 Platform Chats，并让固定 seed Chat `00000000-0000-4000-8000-000000000001` 位于第 16 条；首次安装默认显示 8 条时，确认列表严格等于 Platform 前 8 条，不出现额外的“开始使用”行或聊天引导气泡。
- 点击首装引导卡中的“打开开始使用对话”，确认即使 seed Chat 当前不可见，也导航到带该固定 `chatId` 的真实历史对话，不进入 New Chat 或“初始化助手对话”。
- 点击“查看更多”展开到 16 条，确认真实“开始使用”只在 Platform 排序位置出现一次；点击后路由、页面内容与侧栏选中态都绑定固定 `chatId`。收起 Chats 分组并重新展开恢复前 8 条后，该行和聊天引导气泡都不再显示。
- 分别在 `recent` 与 `manual` 模式重复上述检查，确认 Desktop 不对 seed Chat 置顶、重排或合成。删除 seed Chat 后重新执行首次安装引导，确认引导卡打开 Bootstrap Agent 的 New Chat，但 Chats 列表仍不伪造“开始使用”行。

## Chat information

- 从 Chat 上下文菜单打开信息弹窗，确认标题为 `Chat information`，没有重复说明或分区标题；详情字段、逐项复制、`Copy all`、`Copy JSON`、关闭按钮及键盘 Esc 均正常，浅色与深色主题下紧凑、层级清晰。
- macOS 点击 `Reveal in Finder`，Windows 点击 `Show in File Explorer`；有 Chat 目录时定位该目录，只有持久化 JSONL 时定位该文件。成功后不显示冗余状态行，失败时才显示错误；renderer 返回值和错误信息均不包含绝对路径。
- 使用包含 `/`、`\\` 或 `..` 的伪造 Chat ID 调用 reveal IPC，确认请求被拒绝且不会打开任意目录。

## 设置页操作提示

- 在 macOS 与 Windows 的“网站应用”设置中点击导入并取消文件选择，确认右上角提示出现后约 5 秒自动消失，关闭按钮仍可立即关闭。
- 在上一条提示消失前再次取消导入，确认相同文案从本次出现重新计时 5 秒，旧计时器不能提前关闭新提示；手动关闭后再次触发也应完整展示 5 秒。
- 提示出现后离开设置页并返回，确认无残留提示；页面读取失败的内联错误仍保持可见。

## 开发依赖缓存隔离

- 两个工作目录共享 `node_modules` 时，确认 Vite 分别使用各自的 `.cache/vite`，依次启动开发服务并打开宠物；宠物页面和图标依赖应正常加载，不出现 `504 Outdated Optimize Dep`。

## WebApp 单一展示所有权


- macOS 与 Windows 分别使用有图片的浅色/深色皮肤打开透明 WebApp，确认主区、WorkPanel 和 WorkPanel 全屏透出同一背景，图片不重新裁切或随 guest 滚动。切换皮肤和主区/WorkPanel 转移时输入、滚动与 guest identity 保留；隐藏面板或切到非 WebApp tab 后宿主表面恢复。
- 用明确设置实色背景和背景图片的 WebApp 重复验证，确认页面自有背景优先；普通 Website、Browser、Service 页面不受影响。恢复无图片的默认皮肤及打开独立 WebApp 窗口时检查原有底色，不出现透明到系统桌面的意外变化。

- 导入一个新的 workspace WebApp（至少包含 CSS、JS 和图片资源），确认首次导航后主工作区立即显示完整页面；`.canonical-webapp-layer` 的 computed position 为 `absolute`，layer、surface 与 webview 均为非零尺寸，资源正常加载不能只停留在不可见 WebContents。
- 运行中的 WebApp 从主工作区移到当前 WorkPanel，再跨 Chat 移动并移回主区；每次确认 DOM 中只有一个 webview 且 `guestWebContentsId` 不变，旧位置引用在同一提交消失。
- 隐藏 WorkPanel、切换 Chat和恢复时确认 guest 保持 mounted/inactive；关闭 WebApp tab 时 guest 销毁但 runtime 继续，再次打开产生新 guest。
- 在 WorkPanel 调整宽度、窗口缩放和 WorkPanel 全屏下确认 canonical WebApp 始终覆盖 active item body，不遮挡 tab strip、窗口控制或新增菜单。
- WebApp 已在独立窗口时，WorkPanel 菜单显示已在浮窗并只聚焦窗口，不创建 tab。
- WorkPanel presentation 不进入公开 CDP current，但页面 gateway/bridge、Cmd/Ctrl+W 和上下文菜单仍按 WorkPanel 归属工作；WebApp popup 保持单页，不能打开 WorkPanel 新 tab。
- 停止、启动失败、卸载和退出应用后确认所有 WorkPanel 引用与 canonical guest 被回收；WorkPanel 转移不改变持久 `openMode`。
- 人为构造一次 Surface Registry 拒绝，确认 Main 只记录结构化 reason、surface/renderer/guest 身份和去重汇总，不记录 URL、token、Cookie、页面正文、identity key 或原始 Chat ID。

## Website 关闭快捷键

- macOS 与 Windows 分别打开至少 6 个 Website tabs，把焦点放在网页输入框、标签栏、地址栏与主侧栏，用 `Cmd+W` / `Ctrl+W` 连续关闭：每次只关闭当前 tab，优先选中左侧存活 tab，无左侧时选右侧；快速重复按键不要求重新点击页面。关闭非当前 tab 后，快捷键仍关闭当前 tab。
- macOS 应用菜单的关闭命令与键盘保持一致。关闭最后一个 tab 后退出该 Website 页面，所有 guest 被销毁，持久 Sites 入口仍可重新打开，当前命令不关闭主窗口。
- 保持另一 Website 和其他 Chat 的 WorkPanel 在后台；连续关闭当前 Website 不影响它们。切走或关闭重开 Website 后，旧实例的定向关闭请求不能关闭新页面或窗口。

## Website / WebApp Copilot 后台页面控制

- macOS 与 Windows 分别执行：Website A 发起 query 后切到 B，A 读取、输入、坐标点击、刷新、截图均成功，B 的路由、原生/DOM 焦点、输入框内容与公开 current 保持不变。Tab 键不能进入隐藏 Website 或隐藏 tab。
- 后台 A 的老 tab 打开新 tab，新 tab 再打开后续 tab；每个 popup 只创建在 A，登记后立即可查询和操作。未知 sourceGuestId 不得回退到 B，Blob 保持同来源和 partition，下载既有行为不变。
- A、B 同时运行时分别查询和操作，确认不能跨实例；伪造公共 source、surfaceId 或内部 target 字段不能获得后台权限；Run/Chat/owner 冲突拒绝。
- query 提交后立即切页、隐藏/卸载 Dock、切换 Chat 或进入 Kanban，迟到 acceptance 仍只能绑定 A。提交后先关闭 A 则拒绝建立可用授权；历史 attach 不补发授权。
- 同身份连接重连后继续操作 A，已发命令不重放；Run 终态、退出账号或身份更换后授权失效。多 Run 共享 guest 时直到最后一个授权释放才恢复原后台节流值，Desktop 重启不恢复 grant。
- 关闭单 tab 后旧 targetId 失败；关闭整个 Website、停止 WebApp、重开同名应用或 guest 崩溃后旧授权不能复用，不能重开页面或退回 B。
- WebApp 主区 ↔ WorkPanel 转移保持原 guest 和授权，隐藏 WorkPanel 后仍有有效截图尺寸与坐标；始终单页。切换独立窗口更换 guest 后旧授权失败。
- 回归普通前台 CDP、WorkPanel 私有授权、最后一个 tab 关闭、公开 post-state、截图与下载。
- 可运行隔离的真实 Electron smoke：先 `npm run build:main:types`，再 `node_modules/.bin/electron test/fixtures/site-cdp-electron.cjs`（Windows 使用 `node_modules/.bin/electron.cmd`）。测试使用临时数据目录与 loopback 页面，不连接真实账号；成功输出测试平台及截图路径。该 smoke 不能替代真实 Platform query、Dock 和账号生命周期的端到端检查。
- 同窗口并发输入需单独验收：在 Agent 连续输入时持续给 B 打字，检查字符归属与焦点事件。当前实现使用短暂 guest 焦点事务并在每条命令后恢复，不应将“命令后焦点恢复通过”视为“输入过程中绝无竞争”。

## 本地文件安全宿主

- 多选 HTML、PDF、图片、文本、音频、视频、Office、压缩包和未知格式；支持格式内嵌预览，其他格式只显示系统定位和默认应用打开。
- CuteJ 与 ZenMind 两个品牌分别在 macOS 与 Windows 通过“文件”打开含中文的 UTF-8 Markdown、TXT、JSON 和源码文件（含无 BOM 与带 BOM），确认中文、标点和换行正确，文本中的 HTML 标签按原文显示；带 BOM 的 UTF-16 文本也应正常。HTML 同目录 CSS/JS 仍使用原有资源 MIME。
- 在 Main Chat RightSidebar 与 WorkPanel Artifact/Reference 中分别打开 DOCX、XLSX、PPTX、ZIP 和未知格式，确认双按钮由 WebClient 渲染在 `.content-viewer-panel` 中央，Desktop 外层没有重复操作层；操作成功保持静默，失败显示本地化错误且 guest 消息、renderer/IPC 响应均不包含绝对路径。
- 从带 canonical Chat grant 的内部 Platform Run 调用 `desktop.workpanel.openLocalFile`，确认 workspace 相对路径可打开；绝对路径、`file://`、`..`、缺失 workspace 及所有 HTTP/WS/WebApp/调试入口均失败且不弹确认。
- 重复选择同一文件激活已有 tab；关闭 tab、关闭 workspace、移除 Chat 和退出 renderer 后句柄释放。
- HTML 同目录相对图片/样式可加载；确认 HTTP(S)、WebSocket、FTP、外部导航和 popup 均被阻止，并且没有 Desktop SSO、Token、WebApp bridge、Node 或权限能力。用户手选与内部 Platform Agent 打开的本地文件必须使用相同隔离策略。

## WorkPanel HTML/图片评审批注

- 在 canonical Coder workspace 中分别打开 HTML 与图片；确认静态文档内容区只显示原生单行文档工具栏，不显示浏览器地址栏或重复文件名。普通 HTTP(S)/loopback Web 的工具栏与 Tab 右键提供网页元素批注入口；WebApp、用户手选的项目外文件、PDF/文本及不支持 capability 的 Resource Viewer 不提供网页元素编辑入口。
- 图片在默认窄宽度、宽 WorkPanel、全屏、滚动和窗口缩放下框选多个区域；进入批注模式后确认顶部出现“拖动框选/单击建框”提示，拖动中实时显示红色框，松开后右下角输入框自动聚焦，单击图片也能创建默认大小的批注框。确认画面与列表编号一致，坐标按原图像素显示，删除中间区域后连续重新编号，最多 50 条且每条要求最多 1000 字。
- 打开左栏底部智能图片工具，分别用矩形/椭圆/套索/画笔选区及批注区域执行“按选区 / 批注修改”；确认区域状态可见，修改要求随 PNG 白色蒙版交给 Zenmi，成功后清除已消费的选区与批注。擦除对象仍要求区域；移除/替换背景、扩图和增强入口继续可用。
- 本地、普通 Web 与 Artifact/Reference HTML 分别从预览模式进入编辑模式，确认顶部与图片编辑态一致显示“返回预览”，批注面板只展开当前一条修改要求；悬停并点击同名兄弟元素时页面链接、表单与按钮不执行，批注显示唯一 Full XPath。滚动后定位框跟随；返回预览后页面恢复正常交互且不显示编辑提示。普通 Web 资源版本变化或删除目标元素后显示失效且不能交给智能体。Resource Viewer iframe 继续没有 `allow-same-origin`，其内部嵌套 iframe、Shadow DOM、伪元素、文字范围和自由画笔保持不支持。
- 在已有 Composer 内容时交接图片评审；确认原内容不被覆盖、使用分隔符追加固定格式草稿，并出现带编号矩形的临时 PNG。发送前观察网络请求，确认没有附件上传；点击发送后才上传并随 query 发送。取消、插入失败或图片导出失败时原批注仍保留。
- 交接 HTML 时确认只包含 Full XPath 与修改要求，不包含完整 DOM、密码/表单值、Token、绝对路径或资源鉴权 URL。workspace 草稿要求原位修改；Artifact/Reference 草稿要求保留原资源并生成新版本；普通 Web 草稿包含安全页面 URL，并在无法定位对应源码时明确说明限制。
- 含草稿 tab、关闭其他 tab 和关闭 workspace 都出现确认；取消后草稿保留，确认后清理。退出应用后不恢复批注。分别在 macOS/Windows、浅色/深色、窄布局与 WorkPanel 全屏回归工具栏、底部抽屉/右栏、键盘焦点和不可点击数量徽标。
- 覆盖 `..`、URL 编码穿越、符号链接；Windows 额外覆盖 junction/reparse point，所有目录越界均返回 404。
- macOS 使用 Finder 定位和默认应用，Windows 使用 Explorer 定位和系统文件关联；renderer/API 响应中不出现绝对路径。

## WebApp Zenmi 图片桥

- 在图片工坊中确认能力状态显示为 `Zenmi 智能体 / Desktop`，文生图会创建新的候选图层，响应中不出现 Platform token、绝对路径或完整提示词日志。
- 导入 PNG、JPEG、WebP，建立矩形、椭圆、套索和画笔选区后分别执行图生图与局部重绘；确认原图与 PNG 蒙版经一次性上传，Zenmi 调用 `image_generate`，未选区域和原图图层保留。
- 伪造跨 WebApp uploadId、非图片签名、MIME 不匹配、超过 20 MiB 的单文件、无原图蒙版以及缺少局部重绘蒙版，确认请求在 Main 侧失败且不会启动 Run。
- 生成期间点击取消，确认只中止调用方自己的 Run；重复 requestId 冲突、附件上传失败、工具失败、超时及资源哈希不符都显示可重试错误，不自动转为 Mock。
- 在普通浏览器直接打开开发服务器，确认明确显示开发态 Mock；在 ZenMind Desktop 中不得静默回退 Mock。macOS 与 Windows 均检查 WebApp workspace、WorkPanel 和独立窗口的同源上传与结果显示。

## R0 废弃清理与兼容观察

- 在 renderer DevTools 检查 `window.electronAPI.assistant`，确认 memory 设置/摘要/列表/删除/清空/目录打开和语音纠错/转写方法均不存在；Agent WebClient 的 `/memory` 页面仍可打开，`/api/voice` 仍由 host 按服务配置代理。
- 分别调用规范 `assistant.createProject` 与兼容 `assistant.createCoderProject`；两者创建 CODER Project 的结果一致。连续调用兼容入口两次，main log 只出现一次 `assistant.createCoderProject`，包含当前 Desktop 版本且不含请求内容、workspace 路径或 Chat ID。
- 打开旧 `/service/agent-webclient` 深链，确认重定向到 `/agents`；同一进程重复命中只记录一次。分别以固定旧 surface ID 和动态旧哈希执行受支持的 Desktop Web Action，确认仍解析到 canonical surface，每类与 canonical role 组合只记录一次，日志不含旧 ID、URL、identity key 或 Chat ID。
- 用历史 Program bundle 验证 WorkPanel bridge：v4 仅旧 item 操作，v5 额外支持 resource，v6 支持当前完整能力，其他版本返回 version mismatch；重复同一 `version + method` 只记录一次。验证 `agent-webclient v0.3.59` 被安装/恢复/升级路径升级或拒绝启动，`v0.3.60` 正常启动。
- 在 macOS、Windows 分别执行内置服务首次安装、旧版本升级和启动恢复，确认 identity 公钥由 `auth.publicKey` capability 提供；覆盖 capability 成功、命令失败、结果文件缺失和 canonical `keys/publicKey.pem` 回退，不执行 Desktop 内旧 `.env` 解析、身份脚本或 token 构造路径。
- 在 macOS、Windows 用 Agent Workspace 相对路径执行 `package.init → package.validate(projectPath) → package.build → package.validate(archivePath) → install(workspaceArchivePath) → checkRuntime → open → site.list`；覆盖绝对路径、URI、`..`、控制字符、符号链接/Junction 越界、输出已存在、断连和十分钟超时，确认失败无临时文件且所有响应与 Debug 记录不含 Workspace 绝对根路径。
- 检查开发态与正式安装包：Tooling Worker 存在于 `app.asar` 编译产物，`Resources/scripts/webapp-tooling.mjs` 与 `Resources/tooling/webapp-tooling.mjs` 均不存在，所有内置服务和插件均未收到 `DESKTOP_WEBAPP_TOOLING_PATH` 或运行时 `DESKTOP_ROOT`。正式 `dist:mac/dist:win` 缺少匹配当前 Desktop 版本的 `env.zip` 时失败，开发模式不带 `env.zip` 仍可启动。
- 用 WebApp Builder `0.2.0` 验证 Skill 包没有 `scripts/`、`--desktop-root`、磁盘扫描或 Node 子进程逻辑；版本化事务同步失败时回滚，不能留下新 Skill/旧 Desktop Action 或新 Desktop/旧 Skill 的混合组合。
- 启动、市场刷新、插件加载和升级不再根据退休 denylist 删除、过滤或拒绝任何插件；插件程序、配置、用户数据、状态和日志均保持不变，显式卸载仍遵循现有用户选择。
- 回归 Local Kanban CRUD、Cloud `resyncFromCloud`、`issue.claim`、`issue.run.prepare`、`issue.chat.bind/unbind` 与 `run.event.append`；确认旧 DB/store/upload API 不再出现，已有缓存 schema 和磁盘残留旧文件均未被迁移或删除。

## 会话路由交接与整屏加载

- 冷启动、复用 Main Chat webview、隐藏后恢复分别切入目标 Chat；READY/APPLIED 只确认 Router 接受目标，不能当作数据完成。注入旧 revision、目标不符、旧 webContents、旧 document generation 的迟到 ACK/promotion，不得改写当前目标；约 1 秒 fallback 每次交接最多一次，WebClient 数据超时不触发无限重载。
- 从含产物和计划任务的 A 切入慢加载的 B，再快速切入 C：三个内容区域始终一致，不能出现 A 的产物、计划或顶部旧状态；输入框可见但禁用、侧栏可用。15 秒准备期限和最多 2 秒滚动恢复均有终态；重试仍指向失败目标，迟到数据无效。
- 对 `36a49dee-bab7-4e5b-84c7-07e2e3c5a83a` 做实际安装版切换检查，同时运行可重复的受控竞态联动测试；只用源码测试或版本标签不能代替此项。
- 用 `scripts/verify-webclient-assets.mjs --reference <bundle-dist> --candidate <synced-dist> --candidate <packaged-dist> --candidate <deployed-dist>` 检查 HTML、入口与懒加载 JS/CSS 一致。同步输入须包含完整内置服务集合，其他服务指纹保持不变；不得手工替换安装目录文件。
- macOS 签名/安装与 Windows 原生 PowerShell 打包/安装分别验收，缺少平台或安装授权时记录未完成，不记作通过。

## 设备身份与 Realtime 稳定性

- 在 Windows 启动 Desktop 后从 Debug 记录 deviceId，运行长对话并同时进行高磁盘负载操作；确认 deviceId、Realtime physical generation 与当前 Run 保持稳定，不出现 `realtime identity was invalidated`。
- 模拟启动时 MachineGuid 暂时不可读且已有有效设备身份，确认 Debug 仍显示原 deviceId，身份文件未改写，`lastMachineMismatchAt` 未更新，日志只记录保留已有身份的脱敏诊断。
- 关闭 Desktop 后模拟有效 MachineGuid 发生变化并重新启动，确认首次读取重新生成 deviceId、更新 `lastMachineMismatchAt`，旧 Realtime generation 不被恢复或自动重放。
- 在 macOS 重复上述稳定性检查，确认 IOPlatformUUID 临时不可读时同样保留已有身份，且正常启动不重复执行系统机器标识探测。

## HTML 产物预览与文件操作回归

- 自包含 ECharts HTML 与 HTTPS CDN 版本均能显示图表；外部 CSS、图片、字体、Fetch/XHR 和模块资源正常加载，网络失败可诊断，未关闭 CORS/TLS/混合内容检查。
- 同目录 CSS 的嵌套引用、相对图片/脚本、动态 import 和 JSON fetch 正常；Artifact/Reference 不能读取兄弟资源或经 symlink 越界，Workspace 不能逃出授权目录。
- 验证原始 dashboard 和 dashboard-v2 的全部 9 个图表；调整宽度、切换标签、隐藏恢复及全屏后仍显示，guest 不重建。
- 批注模式可点选元素、填写要求、显示编号并交给智能体；页面 postMessage 不能控制批注。刷新前确认，取消保持原状；刷新后批注保留，缺失目标标为失效。
- 开发启动与打包运行都从实际 preload 路径验证“点击编辑 → 元素高亮 → 点击元素 → 填写要求 → 确认编号”；不能只用测试中重新打包的 preload 代替。检查沙箱日志没有 `module not found`，普通网页/手选本地 HTML 的批注也不受影响。
- 原生 HTML 标签右键包含刷新、复制文件名/语义路径、下载/另存、定位、外部浏览器和默认应用打开；右键刷新与工具栏一致。
- macOS 验证 Finder 定位及指定浏览器打开；Windows 验证 Explorer 定位及浏览器可执行文件启动。HTML 默认关联编辑器时，两种打开入口仍各自正确。
- 覆盖中文、空格、百分号和井号文件名、文件已删除、浏览器不可用、远端仅缓存和取消另存；不得泄漏绝对路径、误开缓存或静默改用其他打开方式。
- 关闭文档/工作区及 renderer 销毁后，旧 handle 和 guest 不再可用；预览不共享 Desktop 登录 Cookie、无 Node/Desktop bridge、popup、自动下载或设备权限。
- 手动选择本地文件的既有离线策略不变。自动化入口：先编译 Main，再运行 `RUN_HTML_ELECTRON_TEST=1 node --test test/document-html-electron.test.mjs`；`HTML_CDN_SMOKE=1` 增加实际 CDN 冒烟。

## 上传 Reference 预览回归

- macOS / Windows 分别上传 PNG、PDF、DOCX、文本；新建与历史 Chat 的卡片均可打开，运行中可阅读，再次点击聚焦同一 Tab。
- 验证 Chat 根目录文件与 `references/` 子目录文件；路径越界、编码遍历、跨 Chat 与逃逸 symlink 仍须拒绝。
- DOCX 查看中文表格、内嵌图片、翻页、缩放与刷新；损坏、加密、超限、无权限、文件不存在时显示可操作错误，不自动下载。
- 图片与文本修改 Reference 只能创建 Artifact；DOCX 保持只读，下载拿到原文件。
- 原生 HTML 根目录上传只能读自身，相邻聊天元数据或其他附件不能作为相对资源读取。

- macOS 与 Windows 分别检查收起侧栏的自动化、新建对话、置顶、对话、项目与站点：图标采用一致的圆角描边、尺寸与居中方式；默认及图片皮肤的浅深色下，未选中项清晰可读，选中项图标和文字使用同一皮肤强调色，无固定蓝色残留；鼠标 hover、键盘焦点和禁用态仍可区分。
- macOS 与 Windows 在浅深色及图片皮肤下检查底部设置入口：常态透明，hover 与菜单打开时显示皮肤配色的圆角底色，收起侧栏时为紧凑方形按钮；展开侧栏的账号、文字布局保持完整，Tab 焦点清晰可见，关闭菜单并移出鼠标后恢复常态。

## WorkPanel 宽度折叠

- macOS 与 Windows 分别向左拖动 WorkPanel 分隔线：Main Chat 到达 420px 后继续向左拖动不足 96px 时保持最小宽度，达到 96px 缓冲阈值后才直接折叠为零宽；导航与 WorkPanel 两条线相距约 6px，且可分别拖动。
- 从折叠位置向右拖动或按分隔线的右方向键，恢复 Main Chat 最小宽度并继续缩小 WorkPanel；验证 Home/End、窗口缩放、导航宽度调整、隐藏/恢复 WorkPanel 和进出全屏，聊天 guest 不重建。

## 启动验证与认证复用

- macOS 与 Windows 分别启动 WebClient：全部检查首轮成功时立即完成，不额外等待复验；每轮公钥准备和 token 签发各一次。
- 让 Platform 首轮返回 401/503、下一轮恢复，确认仍等待重试且下一轮重新签发；持续失败仍按原超时退出，日志包含失败检查项与 HTTP 状态码且不含 token。覆盖 runtime-info 404 的 agents 回退探针。

## 无帮助配置的内网环境

- macOS / Windows 分别以无 help 配置的新环境启动：能力导航、账号菜单和新手引导无帮助入口；Windows 顶部帮助菜单隐藏，“关于”仍在文件菜单，方向键/Home/End 可遍历剩余菜单。
- 直接访问 `/help` 回到控制中心，调用 `help.open` 返回未配置，无帮助 WebView 与网络请求；配置有效帮助地址后重启，入口及匿名 Help WebView 恢复。
- 配置第一方帮助站点后，在 macOS、Windows 的浅深色图片皮肤及自定义照片下打开市场、分享管理与帮助：三个主区都能隐约看见同一张 Desktop 壁纸；帮助站点正文、加载中和失败重试保持可读。切回默认无图片皮肤后分别恢复原有实色底板，Help WebView 仍保持匿名独立 partition 与同源导航。

## 无 IM 配置的云桌面

- macOS / Windows 分别以无 enterpriseIm 配置的新环境启动，完成内网 SSO 后仍无 IM 聊天入口和设置开关；调用开启接口仍返回关闭，不生成默认服务器、不发 HTTP 或 WebSocket 请求。
- 使用带有效 IM 地址的普通环境，验证开关、登录连接、消息收发与关闭流程正常；既有配置不因导入缺少 IM 字段的新环境包而被隐式删除。


## Provider 登记双模式

- macOS 与 Windows 分别检查：无 provider-register.json 时不发送登记请求、不清除已有 Key。
- 旧格式和显式 grant-jwt 均可申请，成功后按原有一次性策略清理；网络失败保留材料。
- macOS / Windows 分别从已消费 Grant（登记文件已删除）的旧版本升级：新 env 包的 Provider Key 为空且包含新登记文件时，deploy 后应申请并写入 Key，再启动模型服务及提交版本。模拟申请断网，确认不提交版本，重试成功；模拟申请成功后其他核心服务失败，确认续跑仍能恢复登记输入，原始备份不被覆盖。同版本普通重启不重放 Grant。
- 已完成版本因缺少登记文件而无法对话时，通过手工导入同版本 env 包并启动服务恢复；新包不含登记文件时不复用旧登记策略，也不额外清除已有 Key。
- access-token 模式下未登录且 Provider 已有 Key：模型服务仍停在登录门禁；身份基础、登录页、控制中心和退出可用。
- 登录完成后自动续跑；请求仅带 canonical access token 和当前 device_id，选定 Provider 使用返回 Key，登记配置保留。
- 同用户同设备重复启动返回同一 Key；退出再登录、切换账号期间，旧消费者先停止，旧响应不能覆盖新账号凭据。
- 启动前残留的 Agent Platform 进程不能绕过登录；控制中心手动启动同样执行门禁。
- 401 最多刷新一次；403/409/429/5xx 和网络错误保留配置并显示脱敏失败，不降级使用 Grant 或旧账号 Key。
- 登录弹窗显示时不被启动进度卡遮挡；取消登录后可以再次登录或打开控制中心。
- HTTPS、系统代理、请求超时和禁止重定向在两个平台分别验证。

## 主导航混合排序

- macOS / Windows 分别在展开与收起侧栏，将看板、新建对话、自动化和多个置顶 Website/WebApp 交错拖动；检查前后插入线、放开提交、Esc 取消和拖到列表外取消，拖拽不得打开页面，点击与右键菜单保持正常。
- 聚焦上述入口后用 Alt + 上/下调整位置，普通方向键仍按视觉顺序导航；移动后焦点留在原入口，首尾不越界。
- 重启确认混合顺序恢复；缺少独立排序文件时使用默认导航布局。已有主导航顺序时，新可用入口（含置顶站点）按可用集合顺序追加，不移动已有项；取消置顶恢复 Sites 原顺序，删除应用不显示幽灵行。Chats/Pinned Chat/Projects 的服务端顺序不受影响。

- 主导航拖拽时目标前后显示与 Chat 相同的蓝色插入线（同一主题色、粗细与圆角），首行、末行及收起侧栏均可辨识；松手位置与提示一致。
- macOS / Windows 分别验证 `config/desktop/navigation-order.json` 只保存主导航顺序，`config/webs/pinned.json` 只保存站点置顶，`config/webs/order.json` 保存 Sites 原顺序；拖动不改置顶成员。缺少独立文件时使用默认空列表，不回退到旧 profile 字段。模拟排序保存失败，原文件保持完整；修改主题或助手不得读写排序与置顶文件。

- 自动化背景协作：macOS / Windows 使用图片皮肤打开自动化页面，确认列表、执行历史与留白按 WebClient 管理页阅读底色透出背景；切换到记忆等未接入页面或移除背景时恢复实色，原 guest 和编辑草稿保持。

## Kanban 当前格式初始化

- macOS / Windows 在浅色与深色下切换默认、森林、海洋等皮肤：Kanban 页面底色、列、顶部栏、任务卡片及拖拽卡片跟随皮肤变量，详情与新建弹窗使用统一浮层表面色；Kanban 仍为实色阅读区域，不直接透出壁纸。切回默认皮肤不残留上一皮肤颜色。

- 新建弹窗没有取消按钮，关闭使用右上角叉号；精简模式项目、版本、工作流同一行，高级模式标题、优先级、重要程度同一行，窄窗口自动换行。切换本地 / 云项目后清除上一个项目的流程选择，本地仅显示本地流程和自由流程，云项目显示服务端流程目录并优先选中项目默认流程；没有云流程时禁用并提示。
- 高级模式自动化使用快捷预设和分、时、日、月、周五段 Cron，支持时区和执行消息。清空任一 Cron 段时不能导致其他段移位，非法 Cron 或时区不得保存，合法配置保存后与执行者一起进入原自动化同步流程。

- 深色 / 浅色下核对高级模式、添加附件、更多 / 收起以及详情蓝色操作使用同一主题强调色（默认深色 #4F88FF、浅色 #2663EB）；切换主题后颜色一致，禁用按钮保持弱化，危险操作保留语义色。

- 仅“待排期”和“待办”列显示新增加号；进行中、审核中、已完成列均不显示，双击也不打开新建弹窗。新建高级模式的状态只能选择待排期或待办，已有任务的正常流转不受影响。

- 新建问题精简 / 高级模式背景与 Cmd+K 使用同一浮层表面色：默认深色为 #2D2D2D，浅色和切换皮肤后也保持一致，不残留精简模式的独立深色覆盖。

- macOS / Windows、浅色 / 深色下打开新建问题并切换高级模式，弹窗及遮罩必须覆盖 Kanban 顶部栏与菜单，遮罩下的顶部栏不能接收点击；高级模式高度不超过窗口的 82% 且最高 760px，内容超出时可在弹窗内滚动至保存按钮。

- macOS / Windows 分别选择执行者并点击标题旁“设为默认”，重新打开新建弹窗及重启应用后自动选中；默认智能体不可用时回到未分配。展开“更多”后按钮变“收起”且左侧显示搜索框，按名称或 AgentKey 过滤；列表最多三行，超出在区域内滚动，收起清除搜索并保留已选项。
- 高级模式在宽屏明显加宽，状态等字段一行四列、执行者卡片显示更多列；窄屏不越出窗口，弹窗可纵向滚动。

- 新建问题中默认流程显示“自由流程”，执行者以小卡片单选并显示选中状态；超过五个智能体可展开更多，收起后仍显示已选执行者。保存后卡片执行者应一致，取消选择后不残留执行者。
- 新建与详情编辑不提供同步开关：本地项目不请求云同步，选择云端项目自动请求云端归属；当前只读合同应明确拒绝云端创建，不得静默保存成本地任务。

- macOS / Windows、浅色 / 深色下打开新建与编辑问题弹窗，切换精简 / 高级模式：输入内容、下拉选项、附件名称和执行者卡片使用常规字重，标签与次要操作适度强调，标题和保存按钮保留层级，避免整张表单粗体。
- macOS / Windows 新建问题时，将原本不在前五位的 Agent 设为默认 Executor，确认立即排到第一位，折叠、展开及重新打开弹窗均保持首位；搜索匹配默认 Agent 时仍优先显示，其他 Agent 相对顺序不变。切换当前选择不改变默认排序；清除默认或默认 Agent 已不存在时恢复原顺序。

- 本地任务在未登录和已登录时都只归入“自己”，不归入“他人／未分配”；本地卡片只显示执行智能体，明确为人工执行时显示“自己”，未指定执行者时不因本地归属添加“自己”。云端任务仍按负责人筛选。
- macOS 与 Windows 分别导入启用看板、云地址为空且关闭远程控制的环境，确认初始化成功、本地 Issue 可用且不连接云端；启用远程控制而缺少地址时初始化应拒绝该配置。
- macOS 与 Windows 分别使用独立临时 Desktop 数据根验证首次初始化：设置保持默认关闭，启用并保存后重启可读取当前 `cloud` 配置，本地 Issue 创建、编辑、日期与 P0–P3 优先级正常。
- 在临时目录放入旧顶层/包裹式 Kanban 配置、旧日期字段或旧筛选存储键，确认不会自动迁移、回填或重写；当前筛选偏好保存后可恢复。不要改动真实用户配置或数据库来执行此项。
- 验证当前 Contract 1.0 的完整快照、账号隔离、断线重连与 run outbox 重试继续工作；Cloud Issue 仍为只读，手动运行继续使用 Server 准备的身份。

## Desktop 在线更新

- 下载时底部按钮显示实时百分比；下载与校验完成后显示“更新 / Update”。点击弹出重启说明，取消不执行安装；确认后走正式安装流程，保留未保存编辑和运行任务保护。开发实例确认按钮禁用并说明原因，安装报错弹窗提示。

- Debug → 测试更新：分别填写 macOS ZIP / Windows EXE 的真实版本、HTTPS 地址、字节数和 SHA-256，或粘贴 JSON，加载后不自动下载，即使原偏好开启也不下载；官网检查不覆盖测试清单。手动下载、校验、签名和安装沿用正式流程；开发模式禁止安装。测试输入错误时保留当前选择，下载过程中不能加载或退出；退出后恢复官网检查，重启不恢复测试清单，canonical 更新配置不变。

- 点击底部 Update 下载时若安装包 404 或校验失败，弹出错误对话框；关闭后 Update 按钮仍保留且可重试。检查接口失败不显示外部更新入口；后台检查错误不主动弹窗。
- 更新按钮默认 20 × 20px，下载图标和文字均为 12px；展开侧栏 hover 时按钮宽度扩展为 64px、高度保持 20px，完整显示 Update／更新。

- 新用户默认不自动下载；有效新版本清单返回后仅显示更新入口，点击底部齿轮位置的更新按钮才下载。安装包 404 时设置页显示下载失败，菜单不显示错误卡片。检查带 v 前缀的本机版本（如 v0.4.5）能正常比较，远端版本仍严格校验。About 更新卡片应保留内边距，仅自动下载选项上方有分隔线。

- 更新接口失败、配置异常或安装错误时，底部菜单不显示更新卡片并保留齿轮，设置页仍可查看错误并重试。有可用更新及下载/校验/待安装期间，下载图标直接替换底部齿轮，不额外显示角标或挤占账号文字；中英文、登录/未登录、侧栏展开/收起均验证。

- 按 `qa/updates/README.md` 验证初始化配置、未登录检查、菜单/齿轮/关于页状态同步、下载校验、任务/草稿保护以及更新失败恢复。
- 分别在签名 macOS 应用与 Windows NSIS 安装应用执行真实更新与失败回归；保留用户数据，验证新版本核心服务就绪。

## 通用插件系统窗口

- 执行 `qa/plugin-startup-smoke.cjs`：真实主进程组合根在 ready 前装配，不加载系统窗口模块及 FFI；未使用插件时不注册监听，提前退出不访问 screen，首次调用后监听只注册和清理一次。

- 独立插件不注册 WebApp、不启动 HTTP 服务即可打开本地界面；验证另一插件无法操作其窗口，越界资源不能加载。
- macOS：便签接受键盘输入和拖动缩放，正常应用覆盖便签；显示桌面、切换 Space 后仍能操作，窗口不变为全局置顶。
- Windows：验证 Explorer 桌面附着、Win+D、多显示器负坐标、不同 DPI、键盘输入与拖动缩放；Explorer 重启应明确报告窗口失效，恢复后可重新打开。
- 编辑自动保存，关闭仅收起；插件再次启动按自己的数据恢复。插件停止、崩溃和卸载不遗留系统窗口。
- 创建窗口失败必须可见，不以普通窗口或全局置顶冒充桌面附着。验证目标平台安装包中包含匹配架构的 Koffi 原生依赖。


### 管理页资源对话入口

- 在五个管理页面点击创建/修改：进入设置中默认 Chat 智能体的 Main Chat；自动化选中 platform-automation，其他四类选中 platform-admin；草稿可编辑、未发送前不产生 Run。
- 修改草稿包含正确稳定标识；Registry 包含分类。刷新不重复预填；返回管理页加载最新结果。市场创建技能仍选中 skill-creator。
- macOS / Windows 均检查管理 guest 向 Main Chat 的 URL 交接；非当前 surface、跨域、含 chatId 或重复 Composer 参数的跳转不能借用该入口。

### 本地阶段工作流（macOS / Windows）

- 关闭云端连接，从看板 setting 菜单打开本地工作流，确认默认开发流程有开发、测试、提交三阶段，缺陷流程多一个提出缺陷阶段；开发和测试默认需要审核。
- 新建、重命名、重排、删除流程和阶段，切换审核开关，保存后重启确认配置保留；取消修改后重新打开确认没有保存。空名称不能保存，至少保留一个流程及一个阶段。
- 创建本地任务选择开发流程，完成开发先进入审核；退回仍在开发阶段，通过进入测试待办。测试审核通过进入提交，提交完成才进入已完成列。详情和卡片展示当前阶段。
- 创建缺陷流程任务，依次走完提出缺陷、开发、测试和提交；从详情及拖拽完成列均不能跳过必需审核，Agent 完成运行只进入审核。
- 修改或删除模板，已有任务保留原流程并可继续推进；无阶段任务保留原有移动规则。重新打开应用后任务阶段不变；云端缓存和云端任务不受本地配置影响。

- 在工作流设置中将测试的回退目标设为开发；只允许选择前面的阶段。删除或重排导致目标无效时保存按钮禁用，需重新选择。
- 测试中或测试审核中点击“退回到开发”，填写原因，确认后进入开发待办；重新经过开发审核、测试和测试审核。详情回退记录显示来源、目标、原因、操作人和时间，重启后仍保留。
- 活动运行期间回退按钮禁用；空原因、未配置的目标以及过期阶段/状态请求在 Main 被拒绝。云端任务不提供本地回退入口。
- 修改模板回退目标后，已有任务不自动变化；点击“应用最新回退规则”只更新路径，保留当前阶段及原审核要求。阶段结构不一致时不提供此操作。

### Kanban 详情与运行聊天（macOS / Windows）

- macOS Finder / Windows 文件资源管理器拖拽多个文件到本地问题编辑态附件区：高亮、松开添加、移出取消提示正常；导入复用原附件存储和解析，保存后重开可访问。连续拖入不重复上传，导入期间保存／取消禁用，正文修改不被导入结果覆盖；只读态和区域外拖入不修改附件、不导航到文件。

- 查看态只在 header 显示标题，正文无重复标题。点击侧栏“编辑”后，左侧仅显示标题输入、问题描述和附件，隐藏运行结果与评论；保存或取消后恢复查看态。编辑时不标记运行结果已读，云端认领／执行入口保持可用。

- 详情及历史记录模式的薄 header 显示项目与问题标题；标题为空时使用描述前 20 个字符（合并空白），长文本省略，不挤压切换和关闭按钮。

- 运行记录的“查看”在当前详情内打开对应 Chat 历史并高亮记录；“跳转”关闭详情并进入该 Chat 主页面，不新建对话或启动运行。其他设备及已不可用的聊天不提供入口，时间与双按钮在窄侧栏中不互相挤压。

- 两平台新建不选流程的本地任务：无标准需求类型或工作流 ID；选择本地开发／缺陷流程时展示快照名称。三个工时不填时保存后重开仍为空并折叠；显式填写 0 显示 0 小时，清空后保存恢复空值；单独修改标题不改变工时。时间值前无日历图标。

- 基本属性默认折叠空值字段，底部显示空属性数量，可一键展开／收起；0、false 与有效自定义默认值保持显示。进入编辑模式显示全部字段并隐藏折叠按钮，保存／取消后恢复折叠偏好，重新打开问题默认收起。人员等其他分组不受影响。

- 本地问题侧栏底部显示薄操作栏，属性独立滚动时编辑、删除仍可见；聊天态点击编辑切回问题详情，编辑态显示保存／取消，保存中禁用相关按钮。云端只读问题不显示编辑／删除。窄窗口检查底部操作栏不遮挡最后一项内容。

- 关闭按钮旁的单个切换按钮在详情、预览、加载态均可用，根据当前视图显示“历史记录”或“问题详情”，无左侧双按钮栏；预览内部无 Chat 标题和“只读 · 历史记录”栏，保留加载、错误重试与会话正文。侧栏锚点为 11px，运行记录仅展示元数据，不展示结果或错误正文；完整结果仍在问题详情中展示。

- 两平台分别在深浅色下检查详情字号：运行结果、问题说明（含编辑态）、附件和评论默认 14px；侧栏从基本属性开始的属性名称和值（含标签、编辑控件与运行指标）为 12px、值为正常字重 400，颜色保持不变。检查长文本换行及窄窗口滚动。

- 打开本地和云端 in_progress 卡片，确认左侧默认通过 `/agent/:agentKey?chatId=` 显示当前 Run 绑定的 Main Chat，可处理等待审批，不使用 `/chat-preview`，右侧仍显示属性、人员、工作流、审核、运行记录和动态，无独立聊天列表；存在更新的历史/参考会话时也不能误选。
- 点击 Desktop 原生窗口头部关闭按钮旁的“问题详情 / 历史记录”单个切换按钮只切换左侧；点击右侧不同运行记录的“查看”切换对应会话并高亮该记录，首次进入历史记录时右侧自动定位“运行记录”锚点；在历史记录内切换运行记录或手动滚动后，运行结束、同步刷新不能抢回右侧滚动位置或用户选择。
- 人工执行无 Chat、其他设备运行、已归档/缺失 Chat 时默认显示问题详情并提示原因；加载本机身份期间左侧显示加载态。非 in_progress 卡片和显式编辑入口仍默认显示问题详情。
- 在两平台分别检查窄窗口、深浅色、关闭重开详情及 WebClient 加载失败重试；右侧仍可访问，打开详情不能新建或重复启动 Run。

- 问题详情左侧按“运行结果、问题说明、附件、评论”排列。本地 Issue 接收 `chat.updated` 后保存结果，详情直接渲染已保存的 Markdown；关闭详情甚至离开看板后完成运行，重新打开或重启 Desktop 后结果仍在。检查 `run.finished` 先到或后到、同一事件重复到达、阶段自动前进后结果到达都不会丢失或重复写入；新运行清空旧结果，旧运行迟到事件和相同 Chat 的无关运行不能覆盖结果。macOS 与 Windows 均验证该流程。云端 Issue 继续读取最近一次运行所绑定 Chat 的 lastRunContent；检查无结果、加载失败、其他设备运行和 Chat 被其他 Run 复用时不显示错属内容。

### Projects 来源与多项目筛选（macOS / Windows）

- Projects 搜索框内右侧显示 All / Local / Cloud，搜索输入、清空和来源切换互不干扰；本地与云端列表均有分组标题，本地默认项目显示“默认项目 / Default project”并排在 Local 分组首位，即使没有 Issue 也可选择，不再显示额外的本地全选行；本地项目与云端项目共用行样式、复选框、计数和悬停效果。验证中英文、明暗主题和键盘操作。
- 现有 Projects 下拉框内切换全部、本地、云端，列表和看板同步按来源筛选；切换来源保留另一来源的勾选，选择全部项目清除所有限制，重启恢复筛选状态。
- 本地默认项目和各问题归属项目平铺展示、独立多选，不显示路径缩进或联动子项目；云端保留树形层级及父子勾选。验证两种来源项目 ID 相同时不会串选。
- 搜索本地项目名称和 ID、云端项目名称和路径，核对无结果提示、项目计数、触发器摘要和多选提示；仅选择本地时不得显示云端问题。

### Kanban Chat Preview 与唯一 live observer

- macOS 与 Windows：打开本机进行中的 issue card，确认左侧为 `/chat-preview/:chatId`，完整历史与增量正常，无输入框；右侧运行记录可切换关联 Chat。
- Main Chat → Kanban 预览 → Copilot → Main Chat，Inspector 始终只有一个活动 Root Observer，均复用 desktop-main Primary WS；旧 detach 完成后才发新 attach/query，不产生 interrupt。
- 快速切换运行记录、返回 Issue 正文、关闭详情及离开 Kanban：旧 guest 注销，旧流不再交付；重新打开从历史游标 attach，后台 Run 继续。
- 预览拒绝 query、BTW、submit、steer、interrupt、access-level、终端写入/关闭与其他 Chat 请求；其他设备 Chat 不可打开。

## 看板终态结果阅读

- macOS / Windows 新建已分配执行者的待办任务，确认至少停留 2 秒才申请启动；期间其他 Run 完成不能提前触发。清空执行者或移出待办后不得启动，重新分配后重新等待，重复通知不能重复执行；简洁与高级模式、无看板页面的 Main 调度均遵守此规则。

- macOS / Windows 分别完成自由任务和 Flow 最后阶段，确认卡片显示未读；Flow 中间阶段、运行中的任务不显示终态未读。
- 中英文下选择本地默认项目并新建 Issue，确认选择器、卡片及悬浮提示、详情项目属性与面包屑一致显示“默认项目”或 “Default project”，不显示数据库中的 “All Projects”；自定义本地项目和云端项目仍显示各自名称。
- 打开详情，等待运行结果成功展示并可见，无需打开聊天即发送精确 chatId/runId 的 `/api/read`；卡片未读与 Chats 导航对应聊天未读同步消失，重启后不恢复。
- macOS / Windows 分别确认上述请求经 Main 注入的身份回调获取 token；首次 401 后重新获取 token 并仅重试一次。请求失败时 IPC 返回固定阶段诊断，不能包含 token 或上游响应正文；恢复后重新打开结果可成功确认已读。
- 同一 Chat 新 Run 完成后重新未读；旧 Run 的迟到请求不能清除新结果。重复展示同一已读结果不重复发送。
- 结果加载失败、Run 不匹配、结果不在可见区域或窗口隐藏时不发送；已读请求失败保留未读，重新打开结果可重试。没有 Chat 的结果只记录本地回执；其他设备 Chat 不调用本机接口。
- 切换账号和云服务后阅读状态隔离，云端 Issue 正文与工作流不发生写操作。

- 在当前品牌数据库创建没有问题的本地项目，重开看板后 Projects 和 New Issue 同时显示该项目；新建问题可选择自由流程或本地工作流，保存后归属正确且不会请求云端创建。不同品牌数据库互不写入示例项目。

## 本地 Kanban 公共调度

- macOS / Windows 分别关闭看板页面，通过普通 Chat 创建 5 个分配了 Agent 的 todo，确认自动进入执行中且每个任务只提交一次 Run；创建后补执行者、修改 workerAgent、Backlog 移入 todo、请求进入执行中也走同一调度。
- 没有执行者、人工执行、定时自动化、Backlog 和审核任务保持原状态；已有 Run 不重复启动。关闭再启动 Desktop，已有可执行 todo 自动调度。
- 模拟 Platform 启动容量拒绝：任务保持 todo、保留错误、延迟重试；普通 Chat Run 结束后及时补位。同一 Agent 有多个可用名额时允许多个运行，不同 Agent 不互相阻塞。
- 快速完成的 Run 在准入响应前结束，不得被迟到响应改回执行中；阶段完成后下一阶段自动执行，需要审核的阶段等待人工批准。显式回退确认文案说明满足条件后自动启动。
- 执行失败和取消后不无限重跑；显式重置为 todo 后重新调度。准入连接中断且无法确认是否接受时保留 Run 身份，不重复 query；关闭 runtime 后停止新增调度。


## 外观 1.1 图标与状态资源

- [ ] 两端使用同一 1.1 契约和已同步的 WebClient Program bundle；旧 1.0 包导入被明确拒绝。
- [ ] 导入并应用 1.1 包：搜索、前后导航、侧栏、看板、自动化、新建对话和内置项目图标按槽替换；用户项目图片与站点 favicon 保持。
- [ ] WebClient 发送/停止、附件、截图、输入框展开/收起与语音图标正确；运行中停止与危险状态仍可辨别，禁用和 loading 不受图片影响。
- [ ] 对话/项目/站点艺术字按中英文切换，缺少该语言时回退文字；读屏名称、键盘焦点、点击区保持。
- [ ] 未读点、1/12/99+ 徽章与 pending 并存可读，皮肤不改变未读计数或已读同步；全局搜索与历史列表同步外观。
- [ ] 快速切换皮肤与浅深色、关闭/恢复 guest、删除当前包、缺失/损坏图片后逐项回退，旧图不串入新皮肤，默认样式无残留。
- [ ] Windows 真机 DPI 与 macOS Retina 验证图标/艺术字清晰；macOS 原生红黄绿与 Windows 原生窗口动作保持。
- [ ] 换肤前后的草稿、附件、光标、审批、滚动、运行和 guest 身份保持；单元与平台 CSS 模拟不能替代此项真机验收。

## 历史弹窗与 Copilot 显示

- 在已打开右侧 Copilot 的 Website/WebApp 页面，macOS 依次按 Cmd+K、Cmd+H，Windows 依次按 Ctrl+K、Ctrl+H：搜索切换到历史弹窗，右侧 Copilot 保持显示并被遮罩覆盖，不出现整块空白，也不抢占历史搜索输入焦点。Esc 或点击遮罩关闭后，原页面、Copilot 会话与未发送草稿保留。通过侧栏“查看历史”重复验证。

## Website Copilot 默认选择与会话恢复

- macOS 与 Windows 分别打开 Website A 的 Copilot 并提问，切到 B 打开 Copilot 再提问，然后返回 A 继续提问；覆盖两站相同及不同 Agent、B 无历史及已有历史会话。确认同一个 Dock WebContents 保持挂载，登记的父网站和上下文随切换更新，无 `surface_identity_conflict`；A 的后台 Run 仍只能控制 A，B 的新 Run 只能控制 B。
- macOS 与 Windows 分别冷打开未设置专属 Copilot 的 Website，确认自动选中全局默认 Copilot；给另一个 Website 设置专属智能体后，确认该站优先使用专属设置。
- 延迟智能体详情加载，确认返回后仍自动选中指定智能体，不停留在未选择状态。
- 在 Website A 切换智能体并打开或创建聊天，切到 Website B、普通 Chat 后再返回 A，确认恢复 A 的智能体与 chatId，B 保持独立；旧页面的迟到 URL 不能覆盖新页面会话。

### Hello Kitty 1.1 重绘

- 导入新版 pink-kitty 包后，搜索／看板／自动化呈猫头或猫耳造型，发送为实心猫爪，前后导航为猫尾箭头；明暗切换同步。
- WebClient 普通皮肤图标为 16×16 CSS 像素，小字号按钮不缩小图片；停止按钮保持 28×28。
- 未读肉垫与数字徽章保持原计数和已读行为；中英文栏目显示猫耳猫尾字形，缺失资源恢复默认图标。

## CDP 字段级错误与恢复

- macOS / Windows 均通过 Platform `desktop_cdp` 发送 `Input.dispatchMouseEvent`：`x: "646"`、`y: "344"`、`clickCount: "1"`；确认一次返回三个字段问题、期望/实际类型、`executed: false` 和修正建议，页面未接收此次事件。
- 将参数修正为数字，再使用小数坐标完成 `mousePressed` / `mouseReleased`；确认 `button: "left"` 和小数坐标正常接受。
- 发送字符串布尔值 `returnByValue: "true"` 或 `ignoreCache: "true"`；确认不再静默转换，报错明确要求 JSON boolean。
- 执行含语法错误及运行期异常的 `Runtime.evaluate`；确认工具报告 `desktop_cdp_evaluation_failed`，保留原始 `exceptionDetails` 和零基行列，不声称脚本无副作用。
- 对已失效 target 调用，确认错误建议在当前 Run 内重新发现授权目标；不要为修复参数错误刷新或关闭未保存表单。表单操作成功须回读并比对期望值。

## 整合 CDP 点击

- 自动验证：`npm run build:main:types` 后执行 `node --test test/desktop-click.test.mjs test/desktop-cdp-params.test.mjs test/site-cdp-control.test.mjs`；真实 Chromium 验证运行 `node_modules/.bin/electron test/fixtures/desktop-click-electron.cjs`，使用隔离临时 profile。
- macOS 与 Windows 分别验证：selector、CSS x/y 两种定位；有/无 waitFor；小数坐标、页面缩放、滚动后点击、遮挡、disabled、多个匹配及视口外坐标。按钮事件必须是 trusted，正常点击仅触发一次。
- 验证等待超时不重放、取消后不新增按下、原 guest 关闭/替换与主 frame 导航后停止 DOM 观察、URL 条件跨导航只读原 guest；其他 Run/原始 CDP 输入不得插入按下和释放之间。
- 配套 Platform 统一通过 desktop_cdp 的 Input.click 执行，请求保持 {method,targetId,params} 结构：一次工具调用、一条反向请求、零参数文件；结果中 action.outcome 与 conditionMatched 分开呈现。旧 Desktop 拒绝方法时不自动重试点击。

## 对话信息与运行记录

- 对话信息运行记录：多个 Run 各自展示 ID、秒级起止时间和整数秒耗时，未结束/缺失时间显示占位符；移除最近运行 ID。逐个复制 Run ID 和运行 JSON，确认 JSON 数组包含原始 JSONL 中该 Run 的全部记录且不混入其他 Run；失败不复制部分内容。Chat ID 旁复制图标复制 ID，“复制图标 + 路径”复制 JSONL 路径，复制全部包含运行列表。macOS / Windows、窄窗口与中英文下检查空间充足时单行、不足时自动换行且 ID 不截断，以及复制反馈；来源、创建时间和更新时间仅显示，不提供单独复制按钮。

## 连接器使用 Desktop 内置 Node

- 固定入口为 `<Desktop 数据根>/bin`；在 Agent Host Bash 和连接器中确认它先于系统 Node。将 npm 全局 prefix 指向系统 Node 所在目录，确认补充 PATH 后 Node/npm 仍命中 Desktop，同时全局 CLI 仍可发现。
- 升级和移动应用后入口路径不变。准备失败保留旧 bin，发布失败回滚；Windows 占用阻止目录移动时明确报错，不覆盖旧 exe。旧哈希目录及退役目录保留给已有子进程。

- macOS 将 nvm Node 16 或 x64 Node 放在用户 PATH 最前；Desktop 启动 Platform 后，经其环境运行 node/npm/企微 CLI，确认 Node 版本与架构跟随当前 Electron，用户终端的默认 Node 保持原样。
- 从 Finder、终端分别启动；连接器的安装、版本检查、登录和业务执行均使用同一 runtime。退出或升级 Desktop 后重新生成当前程序路径对应的入口。
- Windows 使用含空格和中文的应用/数据目录，验证直接 execFile/exec.Command 调用 node.exe，以及 npm.cmd、npx.cmd、子进程参数、退出码与 stdin/stdout/stderr，不弹额外控制台窗口。
- 干净用户环境中不安装全局 npm，确认随包 npm 可以安装固定版本连接器到私有目录；不要把全局安装前缀或账号凭据写进 Desktop 运行时资源。
- 两个平台均检查 Platform 环境没有 ELECTRON_RUN_AS_NODE；该变量只在 node 子进程内出现。缺失/损坏的随包资源在构建/准备阶段明确失败，不悄悄回退到用户旧 Node。

- macOS / Windows 在深浅色下检查 Kanban 卡片：等待审批时右上角状态替换为黄色“等待批准”胶囊，旁边显示导航栏同款黄色旋转指示器，深浅色配色与导航栏 awaiting 一致，底部不重复显示；审批结束恢复原状态；进行中显示导航栏同款灰色旋转指示器，失败／取消不显示旋转图标，仍保留底部诊断状态。

- New Issue 简洁／高级模式：macOS `⌘Enter`、Windows `Ctrl+Enter` 走保存按钮相同校验，按钮显示本平台快捷键；另一平台组合键不触发保存。描述框 `Enter`／`Shift+Enter` 仍换行，中文输入法确认不保存，长按或保存中连续触发不重复创建；保存失败后可重试。

- Issue card 的 awaiting 文案跟随同一 Chat 的导航快照：question 显示等待回答，approval 显示等待批准，form／planning 与导航栏一致；同一 Chat 切换 awaiting 类型立即更新，黄色胶囊和旋转图标保持，结束 awaiting 后恢复进行中。

- macOS / Windows 深浅色与窄列检查 Issue card 字号：主标题 13px，项目名、状态（含 awaiting）、底部负责人／执行者、时间／到期日和操作文字 11px；长标题与长名称仍正确截断，旋转图标不挤压文字。

## WebApp Tooling 故障与恢复

- 在 macOS、Windows 的干净 dev 构建与正式 app.asar 中，通过真实 Platform Run 完成 init、目录 validate、build、归档 validate、install、open、getStatus；install 原样使用 build 返回的 outputPath/id，确认 running 和非空 webUrl。
- 删除测试安装副本的 Worker 入口后调用 package.init，确认返回 tooling_worker_unavailable、ENOENT、not_started 和 repair_host；工程不应创建。不要修改正在使用的正式安装文件。
- 用测试 Worker 注入加载异常、提前退出和超时，确认模型收到原因、执行状态、恢复提示及可关联的诊断编号；不能自动重放写动作或让 Agent 直接启动内部脚本。
- 在当前 Run Workspace 外放置同名 ZIP，确认 install 拒绝而不搜索其他目录；验证缺失文件、错误文件类型、权限拒绝、绝对路径、Windows 盘符及 Junction 越界的诊断分别准确。

## Agents 导航分组

- macOS / Windows 分别在中英文和浅深色下进入 Agents：依次显示平台（智能体、技能中心、连接器中心、Registries、归档对话）、云端（市场、产物、分享）与帮助组（帮助）；禁用市场或帮助时隐藏对应空组，分组标题不可点击，菜单选中态、页面跳转和返回应用正常。

## 能力入口在主导航显示

- macOS / Windows 分别在智能体、技能中心、连接器中心、注册配置、归档对话、市场、分享管理和帮助入口点击行尾“在导航栏显示”按钮：入口加入主导航最前面，当前页面和侧栏不切换；下一次从导航栏打开其根页与支持的详情页使用主导航。再次点击“从导航栏隐藏”后入口移除，当前页面和侧栏保持不变。
- 在展开和收起侧栏中，将能力入口拖到看板、自动化、新建对话、置顶网站入口的前后；验证 Alt + 上/下键排序，重启后顺序和显示状态恢复。能力分组与主导航的按钮选中状态一致，Tab 可聚焦按钮，Enter / Space 可直接切换，不打开弹出菜单。
- 覆盖中英文、明暗主题、窄侧栏和长名称；显示切换按钮可聚焦且不触发导航。禁用市场或帮助后入口隐藏，其他入口排序仍正常，重启及重新启用后恢复原位置；从已显示能力页进入设置后，返回应用回到该能力页。

## 产物管理与导航显示状态

- 默认及自定义皮肤的明暗主题下打开 Settings 弹出菜单，检查四角仅有内层菜单的圆角背景和边框，外层弹出容器透明、无额外边框或阴影；帮助引导仍可显示在菜单外侧。
- macOS / Windows 展开及收起主导航，打开底部 Settings 菜单：底部同一行左侧为 Settings、最右侧为 Help，Help 不独占一行；中英文和明暗主题下均可分别点击及键盘聚焦，禁用帮助后 Settings 正常占满该行，首次启动帮助引导仍锚定 Help。
- macOS / Windows 中英文分别检查能力侧栏和主导航底部 Settings 弹出菜单：云端入口依次为“市场 / 产物 / 分享”与“Market / Artifacts / Shares”；菜单包含产物入口，点击可打开产物页。

- macOS / Windows 中能力侧栏标题为“平台”“云端”，云端按市场、产物、分享排列；产物管理同样支持“在导航栏显示”及混合拖拽。
- 在能力侧栏开启当前入口的导航显示后，页面和侧栏不立即切换；离开再打开后使用主导航。主导航中的隐藏按钮初始不可见，hover 或键盘聚焦时显示，取消显示不导航走；检查前进/后退、设置返回、折叠和重启。
- 管理页关闭时从 Primary WS 接收 resource.pushed 的 artifactId 产物通知，再打开产物管理确认名称、类型、大小、推送时间及来源对话。对同一 chatId + artifactId 重复推送不新增，较旧时间不覆盖较新元信息；不同对话的同名产物独立。
- 检查 `.desktop/data/artifacts.db` 是 SQLite，重启后记录保留；空库显示等待推送状态，不扫描历史产物目录。管理页打开时新产物自动出现，搜索名称、类型、对话 ID，切换分页，来源对话有有效 Agent 时可以打开；历史查询失败仍展示产物和对话 ID。
- 覆盖中文/英文、明暗主题、长名称、50 条以上记录、数据库查询失败、非法 pushedAt、缺失产物 ID、负数字节数和未知推送；非法记录不入库，数据库失败不阻断其他 Broker consumer。非主窗口或子 frame 调用 artifacts.list 被拒绝。

- macOS 与 Windows 在主导航显示智能体、技能中心或产物管理后切换页面：底部账户入口始终显示登录用户姓名（无姓名时沿用账户回退信息）或“未登录”，不显示能力页名称、不随能力页选中而高亮；登录头像固定在姓名前，设置菜单仍可打开。

- 已在主导航显示的能力，从底部账户菜单进入时仍显示专属能力侧栏；覆盖从其他页面进入与当前已经打开同一能力页的情况。返回应用后从主导航点击同名能力仍保留主导航，原有显示偏好与顺序不变。

- macOS 与 Windows 展开及收起主导航时，置顶与未置顶 Website 的行内操作均为普通 Chat 同款三个点，悬停或键盘聚焦可见；点击弹出网站操作菜单，包含取消置顶与关闭，不直接关闭网站。未打开的网站仍可通过三个点菜单切换置顶，关闭项禁用；所有 Website 均不再显示直接关闭按钮。

- 产物管理关闭时，通过 Main WS 接收含多个产物的 artifact.publish，未配置网关上传路由也应逐项入库；随后 resource.pushed 到达时不新增重复记录。覆盖重复序号、非法时间或跨 Chat 身份、BTW lane，均不得产生错误记录；索引写入失败不得阻断对话事件。

- Website 已打开以及 WebApp 已打开或运行时，置顶与未置顶行常态均在原操作位显示绿点；仅鼠标 hover 到该行时同位置显示三个点，移开后即使该行选中或保留焦点也恢复绿点；不新增列、不显示文字提示。覆盖展开与收起主导航；关闭后按实际打开／运行状态清除绿点。

- 主导航的连接器中心等能力入口，行尾显示按钮与网站／Chat 操作位横向居中对齐；只有鼠标 hover 到行时显示，选中及保留焦点不显示。

- 专属能力侧栏中，已设置“在导航栏显示”的条目常驻显示选中按钮，无须 hover；未设置的条目仍仅 hover 显示。主侧栏继续仅 hover 显示操作按钮，不因该规则改变。

### 产物管理列表与操作

- macOS / Windows、中英文及明暗主题：列表依次展示名称、类型、来源对话、大小、时间、操作；长名称/类型/对话最多两行，窄窗口横向滚动，详情弹窗不撑高列表。
- 点击来源对话跳转；点击查看进入该来源对话 WorkPanel 的产物 Viewer；重复查看复用同一产物 tab，不串到当前其他对话。
- 下载弹出系统保存对话框，取消不写文件；中文、空格、百分号文件名保持正确。资源缺失、离线、权限失败显示错误；详情仍可查看。核对超过 100 MB 的文件当前受资源读取上限限制。
- 检查其他 renderer 或子 frame 的 artifacts.act 被拒绝，非法相对路径、外部 URL、跨 Chat 资源引用不能下载。

- 产物查看只依赖当前产物快照：历史事件缺少字段或包含未知事件时仍可打开。旧进程没有 artifacts.act 时提示重启；准备中有状态提示，WorkPanel 拒绝打开时显示失败，不能静默无响应。

## Container / Surface 网页控制（macOS / Windows 均执行）

- 普通 Chat 说“打开 https://example.com”时进入 WorkPanel；结果包含 surfaceId，随后可截图、读取 DOM、输入、导航及关闭。
- 同一 Website 打开两个标签：Surface.list 返回不同 surfaceId、相同 containerId。选择第一个 Surface 后手动切换活动标签，后续操作仍作用于第一个。
- Website Copilot Run 切到后台继续读取、点击和创建 tab；新 tab 可发现。Page.bringToFront 与关闭操作遵循所属容器生命周期，不影响其他容器。
- Chat A 打开的 WorkPanel 网页在切换到 Chat B 后仍可由 A 的有效 Run 操作；B 无法发现或通过已知 ID 操作 A 的网页。终态 Run 不再获得网页操作授权。
- 刷新和导航保留 Surface 身份；关闭重开后旧 ID 失败；排队期间替换 guest 的命令失败且不执行在新 guest 上。
- WorkPanel 本地文件/原生文档不进入普通网页自动化列表，WebApp bridge 不因 Surface 统一而增加权限；普通 Chat 的 HTTP(S) 网页可按原 Chat 授权使用页面提供的 AWCP。
- AWCP 通过同一 `surfaceId` 完成目录读取、带 revision 的章节读取及调用；其间切换活动标签仍操作原 Surface。未读章节、指定其他应用的 Surface、传入 Container ID 或改用另一 Surface 调用须失败，不执行页面 handler。macOS / Windows 均验证页面 CDK 字段错误保留原响应，Desktop 不自动重试。
- WorkPanel 网络页后台截图保留有效尺寸，输入后前台焦点恢复；macOS/Windows 坐标均为 CSS 像素。
## WorkPanel 网站独立窗口

- macOS 与 Windows 分别在同一 Chat 打开三个网站，右键任意网站 tab 选择“在独立窗口打开”：全部网站进入同一个多 Tab 浏览器窗口；文件、Overview 等仍留在面板。每个原 guest 销毁后才创建目标 guest，登录 Cookie 可用。
- 系统标题栏区域显示智能体名称/标识、对话名称与对话 ID 和还原按钮，内容区无重复 header；macOS 原生 traffic lights 与 Windows 系统窗口控件不遮挡文本或还原按钮。长名称和最小窗口宽度下标题截断但还原按钮可用；拖动标题区可移动窗口，点击还原按钮不触发拖动。另一个 Chat 打开独立窗口时不能合并两个对话。
- 标签切换保留各页 DOM/表单状态；前进、后退、刷新、地址栏导航和“+”输入网址新建 Tab 可用。网站 target=_blank、window.open(HTTP(S)) 与后续新页再次新开链接都进入原窗口。
- 切到其他 Chat、隐藏 WorkPanel 或卸载 Main Chat 后，从既有网页打开新 Tab 仍归原 Chat。检查 WorkPanel/CDP：每个 item 与 Surface 独立、ownerChatId/parentSurfaceId 正确，其他 Chat 无权访问。
- 重复打开同一 URL、activateTab 与 refreshWeb 操作既有窗口对应 Tab，不创建重复 guest。窗口无父窗口、modal 或 alwaysOnTop；主窗口与其他应用可正常覆盖它。
- 关闭单个 Tab 只关闭该 item，保留其他网页，含批注时走原有草稿保护。macOS Cmd+W / Windows Ctrl+W 在多 Tab 时关闭当前 Tab，最后一个 Tab 时还原；Cmd/Ctrl+Shift+W 还原整个窗口。
- 关闭整个窗口或点击“还原到 WorkPanel”：全部网站返回原 Chat，保留当前实际地址（含 query/hash）、item/Surface 身份与草稿，选中最后活动的 Tab；不能删除网页。分别从其他 Chat、其他主页面、面板隐藏和主窗口最小化状态验证，连续弹出/还原可用。
- 面板与独立窗口转移后批注保留并标记重载失效，未提交 DOM 状态不迁移。转移失败回收目标资源并恢复原 item；网络加载失败仍可刷新/修改地址。
- 关闭所属 workspace、归档/删除 Chat、主窗口关闭或 renderer 失效均清理窗口、guest 与 reservation。远端页面导航到宿主 restore/action URL 不得触发宿主控制，也不能访问 Desktop preload。
- 自动化补充：先运行 `npm run build:main:types`，再以 Electron 运行 `qa/work-panel-browser-smoke.cjs`；使用临时 profile 和本地测试网站，验证真实新 Tab、后台 Chat reservation、地址栏与整体还原，并输出明暗截图。

### Main WS 产物发布通知

- macOS / Windows 在产物发布前切换到其他 Chat 或产物管理页：收到 `frame: push / type: artifact.published` 后立即入库，不要求来源 Run observer 存在，不依赖网关上传。分别覆盖 MD、PNG、HTML、DOCX、XLSX、PPTX。
- 使用 `publishedAt` 毫秒时间；重复 push、旧 stream 通知及上传完成通知不新增同一 Chat + Artifact。非法时间/缺失身份不入库。离线期间历史漏项不会被此实时接入自动补录。

## 普通 Chat WorkPanel AWCP（macOS / Windows 均执行）

- 普通 Chat 打开提供 AWCP v1 的网络网页：使用返回的 surfaceId 读取目录、按 revision 读取章节并调用；切到其他 Chat 后原 Run 仍可操作。弹出独立窗口后重新发现有效 Surface 并读取手册，不沿用替换前的 guest 绑定。
- 同 Run 的两个网页分别读取目录与章节，调用始终定位指定页面；另一个 Run 即使属于同 Chat，也必须读取自己的手册。
- 普通网站未提供 AWCP 返回 awcp_protocol_unavailable，之后可按任务使用 DOM；协议损坏、版本错误和授权失败不能伪装为无 AWCP。
- 已知其他 Chat、Website 容器或本地文件 ID 不能由普通 Chat 获得 AWCP；无 surfaceId 的普通 Chat 请求不得借用前台页。
- 导航后旧章节调用在 handler 前拒绝，重新读目录及章节后可继续；关闭、替换 guest、Run 终态和身份轮换撤销授权并清理在途请求，不重放业务调用。


### PR #114 上游协议对齐

- macOS / Windows 分别验证主聊天、旁聊、详细解释并行：物理连接标识为 desktop-main / desktop-btw / desktop-explain，出站均为 /api/query，停止和重连只作用于来源 lane。
- 使用 WebClient c2224645 与 Platform 6b23260c 或后续版本：选区批注保留顶层 text、annotation、annotationIndex；添加、纯选区 steer、旁聊和解释续问可用，删除其他批注后编号不重排。
- 实时诊断中选区原文及批注不出现；query/steer 实际发送及回放仍保留完整内容。

## WebApp 统一能力桥

- macOS / Windows：页面从同源加载 SDK，托管 Node 后端使用注入的 `/webapps` token；后端调用认证、权限确认、预览/另存为被拒绝，普通 Website/Tunnel 无法调用页面能力。
- 安装未配置 desktopBridge 的应用，直接调用 CLI/MCP、连接器发现和看板读取，无应用授权弹窗；旧声明为空或 kanbanRead:false 也不限制访问。旧 requestAccess 返回 granted。
- 在两个 WebApp 同时登录同一连接器，只出现一个宿主确认与认证窗口。分别验证 embedded 与 system 入口、成功、关闭、过期；关闭一个应用不取消另一应用共享的 Platform session。
- 登录等待或数据读取期间停止/重启/卸载应用、退出/切换账号，旧请求不投递结果；重新登录后重启应用，无需重新授权。确认前后不向 WebApp 暴露 token 或认证 URL。
- 固定 Copilot 使用指定 Agent 与声明技能；选择未声明技能或自行传 agentKey 被拒绝。后台运行订阅只含文本/状态，停止订阅不重提请求，其他应用不能停止运行；游标过期得到明确错误。
- 完成 Agent 报告后以 chatId/runId 列产物；其他应用、未知 chatId、只有 artifactId 均被拒绝。检查预览、系统另存为、取消保存、超 1 MiB 文件；两平台路径均来自系统选择器。
- 看板读取无需额外确认；返回值不含本机路径、其他 Chat 权限，云断连隐藏云缓存；无 issue 写接口。自动化与其他预留原生能力返回 not_implemented。

- 连接器共享凭据版本：WebApp 无需 connectorAuthentication 声明即可经宿主登录流程认证；backend 仍不能发起登录。已有连接器登录应直接复用，管理界面退出后 Agent/WebApp 同步失效；不创建额外用户凭据目录。工作台登录后直接读取企微数据。

## WebApp 连接器直连读写

- 安装新版个人工作台，登录后直接读取和发送，无应用级读写授权弹窗。
- macOS 与 Windows 均使用各自包内原生 CLI 入口；不经过 Shell 拼接参数。
- 文档查询显示当前企微用户未完成数量及最新五条，支持全部未完成/链接视图；检查姓名相同但 ID 不同的人不会混入。
- 日程和会议按日期读取、会议翻页完成再合并；共享日历有标记，单路失败不会伪装为空数据。
- 只在测试连接器上验证：双击发送、刷新页面、Platform 重启后相同幂等键不会重复执行；未知结果不重放。真实群发送由用户自行点击验收。
- 受管后端不能调用页面专属连接器接口，也不能获得页面短期调用凭据。

## 通用连接器执行 v2

- 新工作台不声明连接器权限即可使用 wecom CLI；重启应用后不出现再次授权。
- 旧 operationId 请求与旧读取权限不能进入新执行路径；后端 token 不能调用 connector.invoke。
- 查询当前用户、会议/日程、文档数量及最新五条；业务解析只在工作台。
- macOS 和 Windows 验证中文 JSON、引号、百分号与 shell 元字符原样作为参数传递；不支持的 Windows 启动器明确报错，不退回 cmd /c。
- 群消息用模拟接收端验证一次派发、重复键回执、冲突和未知结果不重发；真实发送需用户点击。

## Sites 混合排序与 WebApp 菜单

- macOS / Windows 分别拖动 Sites 中的 Website 与 WebApp 交错排序，检查插入线、Esc 取消、普通点击与右键；Alt + 上下键移动，展开列表和收起侧栏的 Popover 都可使用。重启后顺序恢复到 `config/webs/order.json`；置顶后再取消置顶保留 Sites 原位置，主导航、Projects 与 Chats 排序不变。
- WebApp 右键菜单在展开、收起、置顶入口均包含 Pin/Unpin、Close、New window（独立窗口模式为返回工作区）和 Uninstall；没有 Publish、复制发布链接或 Export。不可卸载应用保持 Uninstall 禁用；关闭与卸载执行期间相应操作禁用。

## WebApp 双端连接器与工作台后端

- macOS / Windows 使用同一安装包验证页面与托管 Node SDK 的 connector list/describe/CLI/MCP 调用；后端不能调用登录和文件选择，token 不进入页面或日志。
- 关闭页面后直接调用受管后端仍可完成查询；停止应用或退出账号后旧 token 拒绝，重启应用恢复。执行期间换账号不得交付旧结果。
- 工作台升级保留 SQLite 待办与 unknown/succeeded 提醒回执；日程部分失败保留完整缓存，切换账号不显示旧数据。
- 检查远程 Origin、无来源和跨站请求不能调用个人数据/发送接口；重复点击和发送超时不会自动重发。真实发送仅用明确授权的测试群。

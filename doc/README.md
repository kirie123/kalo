# Kalo 设计文档索引

`doc/` 是设计文档目录：`YYYY-MM-DD-<主题>.md` 设计文档保持本地（**不入库**）；本索引与 `troubleshooting/` 随仓库分发。这里是入口：改代码前先按域找对应设计，排查问题先看 [troubleshooting](troubleshooting/README.md)。

约定：设计文档 `doc/YYYY-MM-DD-<主题>.md`，中文；契约/架构级改动先写设计再动手。区域约定以最近的 `AGENTS.md` 为准。

## 路线图 / 总体

- [Kalo 个人 Agent 路线图（通用底座 + 提示层）](2026-08-17-personal-agent-roadmap.md)
- [kalo-desktop 距离生产级的差距：诊断与分期](2026-08-19-生产级差距诊断.md)

## 会话与输入

- [输入区斜杠命令与 @ 文件补全 + 文件面板后退导航](2026-08-15-input-completion-and-panel-nav.md)
- [每轮 token 消耗与缓存命中率页脚](2026-08-15-turn-usage-footer.md)
- [输入框支持粘贴文件与拖拽文件](2026-08-17-input-paste-and-drop-files.md)
- [新会话在侧边栏的即时显示](2026-08-19-instant-session-in-sidebar.md)
- [会话标题重命名](2026-08-20-会话标题重命名.md)
- [会话自动命名](2026-08-21-会话自动命名.md)
- [todo_write 任务清单工具](2026-08-21-todo-write-任务清单.md)

## 文件面板

- [历史会话快速加载 + 文件面板增强](2026-08-15-fast-history-and-file-panel.md)
- [一轮结束后的「改动文件」汇总卡片](2026-08-18-turn-changed-files-card.md)
- [文件面板 git 感知：只读状态 + diff 查看](2026-08-19-file-panel-git.md)
- [附件从「内联内容」改为「路径引用」](2026-08-20-附件改为路径引用.md)

## 界面与交互

- [桌面端交互卡顿治理（模型切换等 1~2s 延迟）](2026-08-17-ui-responsiveness.md)
- [首屏快捷场景按钮](2026-08-20-首屏快捷场景.md)
- [定时任务的频率选择界面（不再让用户写 cron）](2026-08-20-定时任务频率界面.md)
- [界面风格改版（第一期：令牌层 + 首屏 + 输入框）](2026-08-25-界面风格改版.md)
- [首次使用引导](2026-08-25-首次使用引导.md)
- [右键菜单](2026-08-27-右键菜单.md)

## era 演化实验

- [era 演化实验接入 kalo-desktop](2026-08-18-era-evolve-panel.md)
- [era 面板：自然语言配置 + 可视化与调试](2026-08-18-era-panel-nl-config-and-debug.md)
- [era 依赖与按需安装](2026-08-20-era-依赖与按需安装.md)

## 检索与知识

- [统一检索 `recall`：SQLite FTS5 + trigram](2026-08-18-recall-fts5.md)
- [知识笔记：把知识库升级成 Kalo 自主经营的笔记库](2026-08-19-knowledge-notes-panel.md)
- [memory 生命周期：从仓库回到索引](2026-08-19-memory-lifecycle.md)

## 科研 / 金融数据（skills 生态）

- [科研与实验能力设计（论文沉淀 / 在线调研 / 实验队列 / math）](2026-08-15-research-experiment-capabilities.md)
- [Feeds：声明式定期拉取机制](2026-08-20-feeds-declarative-data-pull.md)
- [market-data：金融取数底座 + 宏观风向 / 财报两个 skill](2026-08-20-market-data-framework.md)
- [个股体检：把一份人写的清单变成可核对的事实 JSON](2026-08-20-个股体检.md)
- [装完即可用：市场数据运行环境与自带的每日拉取](2026-08-20-装完即可用.md)

## 运行时与平台

- [P0-1 Job Runtime + P0-2 Channel 设计文档](2026-08-17-p0-job-runtime-channel.md)
- [版本号管理](2026-08-19-版本号管理.md)

## 维护约定

- 新增设计文档：`doc/YYYY-MM-DD-<主题>.md`，并挂到对应域下。
- 文档失效/被取代时，保留历史但在本索引标注「已废弃，见 <新文档>」。
- 调试陷阱进 `doc/troubleshooting/`（入库，随仓库分发），不占设计文档名额。

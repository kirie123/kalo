# 演化任务契约与分级验收

## 范围

演化仍由普通后台任务启动 `era serve`，桌面仅消费 trace，不增加 Rust、gateway 或引擎协议。保留现有模型与凭据选择。旧实验配置、旧 trace 继续可读。

## 配置

`era-run.json` 新增可选 `contract`，指向工作区内或绝对路径的任务契约 JSON；启动时解析成绝对路径并传 `--contract`。契约 version=1，包含 name、files（种子目录内受保护文件）、stages。阶段包含 name、level（quick/full）、command、checks（必须完成的检查名）、可选 timeout_s。必须至少有一个 full，所有 quick 排在 full 前面。

阶段命令最后一行返回 JSON：stage、status（PASS/FAIL/INCONCLUSIVE/INFRA_ERROR）、checks_completed；可附 reason 与有限数值 metrics。字段与阶段配置不匹配不能通过。命令工作目录为一次性候选副本；quick 阶段不装载留出数据，最终验收可装载；副本写入全部丢弃。阶段中的 python 命令使用运行 ERA 的解释器解析裸 python/python3，其他命令由任务提供。

## 冻结与判定

ERA 在启动时保存契约及基线文件指纹，固定评分配置；quick 门检查失败时候选不得取得有效搜索分数。结束后对搜索冠军重跑全部阶段；仅全部通过并且候选、基线与裁判未漂移时登记 accepted。best 仍是搜索冠军，accepted 是经完整验收的交付物，二者独立展示。没有契约的旧运行显示“未配置验收”，不能显示已验收。

新增 trace 事件 contract_frozen、acceptance_stage、acceptance_finished；run_finished 增加 acceptance 与 accepted。每个阶段包含 node_id、scope（screen/final）、level、status、checks_completed、reason、metrics、contract_id、candidate_hash。缺少完整结束事件时只展示已有阶段，不推断验收成功。

## 前端

配置校验支持 contract 字符串往返及 shell 安全引用；面板显示契约、验收状态、阶段结果及通过后的产物入口。LCB 选优按 selection_score，旧事件回退 score；图表标注其采用的评分口径。搜索冠军与已验收产物分别显示。

通过记录必须覆盖冻结契约的全部阶段、顺序和必做检查，并与候选指纹一致。缺少冻结规则或最终产物记录时不显示已通过。

## 使用

先让演化设置使用包含本次更新的 ERA 源码或安装版本。工作区现有的 `era-run.json` 增加 `"contract": "contract.json"`，契约里的受保护文件相对于 seed，阶段命令在候选的临时副本中运行。验证页会显示规则路径；运行结束后的验收卡片显示具体失败原因，只有完整通过才出现“打开已验收产物”。已有搜索任务不会因为缺少契约而被阻止，只显示“未配置验收”。

协议样本 `src/features/era/fixtures/graded-serve.jsonl` 来自更新后 ERA 的真实离线 serve 子进程：graded 示例裁判、正确多项式基线、fake_pi、预算 1；去除机器路径、时间及无关引擎事件，只保留字段白名单。测试按 13 字符分块重放，以验证增量日志读取。该样本证明协议互通，不证明真实模型的优化能力。

## 边界与验证

临时副本隔离工作区副作用，不宣称同用户进程的 OS 安全沙箱。恶意程序跨目录访问仍需外部权限隔离。分级验收不自动证明数值等价，检查内容由任务提供。

验证：ERA 留出副本回流回归、max/min LCB 回放及旧日志兼容、契约路径/字段/哈希/阶段负例、离线 serve 全链路；桌面 spec 解析与命令引用、事件增量折叠、阶段失败与最终通过、旧 trace 兼容。Windows/macOS 统一使用 pathlib/临时目录；job 命令仍按现有 bash 引用层处理。

2026-10-28 实测：ERA 251 项全量测试通过；本仓库 changed-aware 检查通过，TypeScript 无错误、61 个测试文件共 786 项通过；文件长度检查通过。实际测试环境为 Windows，未实机验证 macOS，未做原生桌面 UI 手工验收、付费模型调用或 GPU 训练。代码实现已完成，运行时需选择更新后的 ERA；已有安装版本不会随源码改动自动更新。

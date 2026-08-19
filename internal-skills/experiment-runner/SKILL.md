---
name: experiment-runner
description: 按队列自动执行模型训练实验并记录结果。当用户要求跑实验、执行实验队列、监控训练进度时使用。
---

# 实验队列自动执行

## 工作区约定（当前项目目录下）

    experiments/
    ├── queue.md              # 实验队列：每条含名称、目的、配置要点、状态
    ├── runs/<名称>/
    │   ├── config.yaml       # 超参数
    │   ├── run.log           # 训练输出（后台进程重定向）
    │   ├── result.md         # 完成后写的结果分析
    │   └── status            # pending / running / done / failed + PID
    └── findings.md           # 跨实验结论沉淀

## 循环协议

1. 读 experiments/queue.md，取第一个 pending 实验；没有 pending 则汇报整体状态并结束循环。
2. 把该实验标记为 running（同时更新 queue.md 和 runs/<名称>/status）。
3. 启动训练，必须"启动即返回"，绝不在前台等训练结束：
   - 先判断平台。
   - 本地 Windows：

         powershell -Command "Start-Process -WindowStyle Hidden -FilePath python -ArgumentList 'train.py' -WorkingDirectory '<run目录>' -RedirectStandardOutput run.log -RedirectStandardError run.err"

   - 远程 Linux（通过 ssh）：

         ssh <host> 'cd <run目录> && nohup python train.py > run.log 2>&1 & echo $!'

   - 把 PID 记入 runs/<名称>/status。
4. 轮询：bash sleep 300，然后 tail run.log、确认进程存活、查看 GPU（本地 nvidia-smi，远程 ssh <host> nvidia-smi）。
   发现 loss NaN、CUDA OOM、进程异常退出 → 转失败处理（第 7 步）。
5. 训练正常结束：
   - 写 runs/<名称>/result.md（最终指标、曲线要点、与预期的对比、下一步建议）
   - status 改为 done，更新 queue.md
   - 关键结论 memory_save（tags 含 experiment），并追加到 experiments/findings.md
6. 回到第 1 步取下一个实验。
7. 失败处理：status 改为 failed，保存 run.log 尾部 100 行与 config.yaml 快照到 result.md，明确通知用户并停止循环——不擅自改参重试。

## 规则

- 每次状态变更立即落盘：queue.md 和 status 文件是真相来源，对话中断后可据此续跑。
- 训练脚本模板可选 wandb 埋点；不用 wandb 时必须保证指标每 N step 打印一行到 run.log，否则无法监控。
- 队列顺序由用户控制：不加塞、不调序、不擅自增删实验。
- 用户随时可能打断询问进度：根据 queue.md 和 status 如实汇报。

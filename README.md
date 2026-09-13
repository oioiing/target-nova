# 智药星图

基于生物大模型的药物智能筛选与重定位平台。

## 功能

- 输入蛋白序列与候选药物库
- TSEDTA / MREDTA 亲和力计算与 Top-K 排名
- CSV 候选库上传与结果导出
- 交互式 3D 蛋白结构示意
- SQLite 任务记录

平台提供药物-靶点亲和力计算、双模型对比、结果可视化和报告导出功能。

## 本地运行

需要 Python 3.10 或更高版本，无第三方 Python 依赖。

```bash
python server.py
```

打开 `http://127.0.0.1:4173`。

## Render 部署

仓库包含 `render.yaml`。在 Render 中选择 **New Blueprint**，连接本仓库即可创建 Web Service。

免费实例重启后 SQLite 任务历史可能被清空。如需长期保存任务记录，可升级持久磁盘或迁移到托管数据库。


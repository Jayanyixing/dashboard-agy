# dashboard-agy

Antigravity 辅助侧边栏实时监控插件（Sidecar Web UI + Lifecycle Hooks）。

## 功能

- **DSH 风格摘要条**：实时展示 `轮数 / 步数 · 估算速率`、`累计 Token · 缓存命中率`、`上下文窗口占比`
- **关键指标卡片**：
  - 上下文窗口环形进度条、已用 / 剩余 / 峰值 Token 与容量状态
  - 累计 Token 分布（缓存读取 `cache_read_tokens`、非缓存输入 `input_tokens`、模型输出 `output_tokens`）
  - 整体与单步缓存命中率
  - 轮次、步数（模型调用 vs 工具步）、会话耗时与端到端估算 `tok/s`
- **每轮明细表**：逐轮查看用户输入摘要、步数、Token 消耗、缓存命中率、结束时上下文占比
- **自适应界面**：支持随 Antigravity 宿主明暗主题切换与侧边栏拖拽宽度自适应

## 本地开发与测试

```bash
npm test
npm run dev
```

## 安装到 Antigravity 全局插件目录

```bash
npm run install-plugin
```

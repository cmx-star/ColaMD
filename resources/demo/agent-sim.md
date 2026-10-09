# Agent 实时同步模拟

这是 loomark 的核心能力：**外部程序修改 .md 文件，窗口自动刷新**。

## 试试

在终端运行（注意用当前目录的完整路径）：

```bash
echo '- Agent 刚写入的一行：$(date)' >> /path/to/agent-sim.md
```

窗口里的内容会**自动出现**这一行，标题栏右侧的小圆点会短暂变橙/变绿（Agent 活动指示器）。

再试试原子保存（Agent 常见做法）：

```bash
printf '# 重写\n\nAgent 用临时文件 + rename 覆盖了整个文件\n' > /tmp/rewrite.md
mv /tmp/rewrite.md /path/to/agent-sim.md
```

## 注意

- 外部改动**总是**实时进入编辑器，覆盖你的未保存编辑——这是刻意的：Agent 写的算数
- 你的编辑需要 **⌘S** 保存才写回文件
- 本页是演示副本，玩坏了没关系

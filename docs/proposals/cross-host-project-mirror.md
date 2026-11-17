# 跨机同名项目

本机只填名字创建的项目，可以从 Composer 的 Harness 菜单选择其他机器上的 Harness。目标机器创建同名目录和原生远程项目，打开新对话并预选 Harness。

入口只对新对话和可识别的本机单目录项目开放。已有目录和登记过的镜像可复用；路径被其他项目占用时按名称编号。项目与目录创建使用 Desktop 服务，Harness 枚举来自对应 Host。

当前实现、失败处理与约束见 [架构文档](../architecture/cross-host-project-mirror.md)。

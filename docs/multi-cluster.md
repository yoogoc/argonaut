# 集群切换设计（提案）

> 状态：已实现（2026-10-23）。生产部署只管一个集群（部署在 EKS），DESIGN.md §8 的“单集群”决策不变。
> 本提案只增加一个**由配置开关控制**的能力：在界面上把这个 argonaut 实例切换到另一个集群。
> 生产关闭开关，行为与现在完全一致；本地开发打开，用来在多个集群之间来回看。

## 1. 行为

- 同一时间只连接**一个**集群（“当前集群”）。切换是整个实例的状态，不是每个用户各自的视图。
- 页面顶部、命名空间切换器左边出现集群下拉框（开关关闭时不显示）。选择另一个集群后：
  1. 服务端先连接新集群（读控制器 ConfigMap、建 informer、等缓存同步，最多 30 秒）；
  2. 成功后原子地切到新集群，再断开旧集群；失败则留在旧集群并在页面上提示原因；
  3. 页面清空缓存，回到工作流列表，命名空间换成新集群的第一个。
- 切换期间新请求仍由旧集群应答，不会出现半新半旧。正在进行的实时流（工作流 watch、日志）在切换后被服务端关闭，页面自动重连到新集群。
- 其他打开着的页面（别的标签页、同一实例的其他人）在下一次请求时发现集群变了，顶部提示“集群已切换为 X”并刷新。

## 2. 配置

**从 kubeconfig 选择（本地推荐）**：kubeconfig 里的每个 context 都是一个可选集群，不用逐个列出。

```yaml
cluster_switch:
  enabled: true              # 生产保持 false（默认值）
  from_kubeconfig: true      # kubeconfig 的每个 context 都是一个选项；每次打开列表都重新读取，新加的 context 不用重启
  default: default           # 启动时连接的 context；为空则用 kube.context，再用 kubeconfig 的 current-context
  clusters:                  # 可选：按 context 名覆盖设置
    - id: default
      name: 本地 k3s
    - id: arn:aws:eks:us-east-1:123456789012:cluster/web-prod-cluster
      env: prod
      kube:
        exec_env: { AWS_PROFILE: prod }
```

- id 就是 context 名；显示名对 EKS 取 ARN 末尾的集群名。
- 环境按 context 名推断（整词 `prod` / `prd` / `production` → prod，含 `uat` / `staging` → uat），覆盖项里的 `env` 优先。
- 其余设置（命名空间、Argo 控制器命名空间等）沿用顶层 `kube` / `argo` 段。
- Argo 控制器 ConfigMap：配置的名字在该集群不存在时，在控制器命名空间里找唯一一个 `*workflow-controller-configmap`（直接安装与 Helm 安装的命名都能找到）；找不到或有多个时给出明确错误。
- 集群的 Argo 持久化库（归档 / offload）连不上时（常见于本地连云上集群，库在内网），只关闭该集群的归档，集群照常可用。

**逐个列出**：不开 `from_kubeconfig` 时，`clusters` 就是全部选项，每项写自己的 `kube` / `argo`（未写的沿用顶层）：

```yaml
cluster_switch:
  enabled: true
  default: local
  clusters:
    - id: local
      name: 本地 k3s
      kube: { context: default }
```

- 这一段写在 `configs/local/config.yaml`（不进 git）。默认配置里不出现，生产部署不会误开。
- `exec_env` 交给 kubeconfig 的 exec 凭证插件（如 `aws eks get-token`），GoLand 从 Dock 启动时没有终端里的环境变量。

## 3. 服务端

**运行时可替换**：现在 `pkg/argo` 的 `Clients` / `Servers` / `Cache` 由 Wire 在启动时各建一份，8 个 biz/service 文件直接持有它们。改为：

```
ClusterSwitch
  current  atomic.Pointer[Runtime]     // Runtime = Clients + Servers + Cache + 集群 id
  Current() *Runtime                   // 每个请求开始时取一次，整个请求用同一个
  Switch(ctx, id) error                // 建新 → 同步 → 交换 → 关旧
  Subscribe(fn)                        // 切换后通知：授权、模板历史重新挂到新缓存
```

- 开关关闭时，`ClusterSwitch` 只有一个 Runtime，`Switch` 不可用，其余代码路径相同。只维护一种写法。
- 每个请求在入口处取一次 `Current()`，避免一个请求中途跨两个集群。
- 订阅缓存的两个组件在切换后重新挂接：授权（模板增删 → 孤儿授权判断）、模板修订历史（外部修改检测）。

**API**（开关关闭时返回 404）：

| 方法 | 作用 | 权限 |
| --- | --- | --- |
| `GET /api/v1/clusters` | 可选集群列表、当前集群、各自的 env 和上次连接错误 | 已登录 |
| `PUT /api/v1/clusters/current` `{id}` | 切换 | 超级管理员（切换影响整个实例） |

`GetInfo` 增加 `cluster`（当前集群 id 和名称）；每个响应带 `X-Argonaut-Cluster` 头，前端据此发现集群已被别人切换。

## 4. 数据

- **模板修订历史**：`template_revisions` 加 `cluster` 列（开关关闭时为空串），查询和外部修改检测都按集群区分。否则切到另一个有同名模板的集群时，会被误记成一次“集群外修改”。
- **审计**：`audit_events` 加 `cluster` 列，记录操作发生在哪个集群。
- **授权**：所有集群**共用**一套授权数据。本地开发用超级管理员身份，影响不大；如果给普通用户授了 `argo` 命名空间，切到任何集群都生效。文档里写明这一点，不做按集群隔离（那是完整多集群的工作量）。

## 5. 界面

- 顶部集群下拉：显示名称、env 色块、连接中的转圈；选项里显示上次失败原因。
- 切换时整页遮罩“正在连接 EKS web-dev…”，成功后跳回工作流列表；失败弹出错误，留在原集群。
- `env: prod` 的集群，顶部栏整体加红色细边并显示“生产”标记，提醒正在操作生产。
- 链接不加集群名（只有一个当前集群），分享出去的链接打开时如果当前集群不同，页面提示链接可能属于别的集群。

## 6. 工作量与顺序

1. 服务端：`ClusterSwitch` 与 8 个文件改为每次取当前运行时；切换流程；两个订阅者重新挂接；API 与响应头。
2. 数据迁移：`template_revisions`、`audit_events` 加 `cluster` 列。
3. 前端：集群下拉、切换遮罩、prod 标记、被他人切换后的提示。
4. 测试：切换成功、新集群连接失败时保留旧集群、切换期间请求不混用两个集群、修订历史按集群区分；本地用 k3s 与一个远端集群实测。

## 附：完整多集群（不做）

同时连接多个集群、权限按集群区分、链接带集群名、跨集群聚合列表——生产只管一个集群，目前不需要。若将来需要，注册方式参考 Argo CD：用 Kubernetes Secret 注册集群、`cluster add` 命令在目标集群建专用账号、EKS 用 IRSA、不可直连的集群走 agent。

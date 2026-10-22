# argonaut 设计方案

> argonaut 是面向 Argo Workflows 的一体化页面工具：**控制台**（Workflows / WorkflowTemplates / CronWorkflows 的查看、操作、提交）加上**可视化编排器**（在画布上编辑 WorkflowTemplate），统一走 OIDC 登录和细粒度权限控制。
>
> 参考项目：
> - `~/Projects/go/project/xyflow-mono`：控制台、直连 K8s、日志/产物/offload、OPA 鉴权，已在真实集群验证。**控制台部分以它为基线直接移植。**
> - `~/Workspaces/dflow`：React Flow DAG 编辑器、按类型切换的任务表单、YAML 双向同步。**编辑器的交互参考它，数据模型不沿用。**

## 0. 已确认的前提

| 项 | 决定 |
| --- | --- |
| 定位 | 控制台与编辑器合一；编辑器**直接产出原生 WorkflowTemplate**，不引入 dflow 的 Widget / WorkflowDefinition 自有模型 |
| 仓库 | 单仓 monorepo（server + ui + proto 放在一个 git 仓库） |
| Argo 接入 | 直连 Kubernetes API，不依赖 argo-server（沿用 xyflow 方案） |
| 鉴权 | OIDC 登录加细粒度授权；策略语言不限定 OPA；**授权数据必须一致**（§4 重点展开） |
| 受管范围 | 单集群、多 namespace |
| 授权主体 | 首版只做用户级；grants 表保留 `subject_type`，以后可扩展到组 |
| 资源类型 | WorkflowTemplate、**ClusterWorkflowTemplate**、Workflow、CronWorkflow |
| GitOps | 首版不做，设计上预留（§3.6） |
| xyflow 数据 | 不迁移，argonaut 从空库开始 |

## 1. 总体架构

```
浏览器 (React SPA，由 server 内嵌静态资源提供)
   │  HTTP + SSE (Authorization: JWT, X-Authz-Revision)
   ▼
argonaut-server (Go / Kratos v3, 单二进制)
   ├─ OIDC 登录 → 自签 JWT
   ├─ authz：Cedar 策略引擎 + PostgreSQL 授权数据（带全局 revision）
   ├─ cache：Argo CRD informer（列表/Watch 走内存索引）
   ├─ pkg/argo：Argo v4 Go 库 + client-go（操作、日志、产物、offload、lint）
   └─ 审计：所有写操作记 PG（K8s 侧只看到平台 SA）
   ▼
Kubernetes API (Workflow / WorkflowTemplate / CronWorkflow / Pod logs / Events)
   + 产物仓库（从集群 configmap/secret 运行时解析）
   + Argo 持久化 DB（offload/归档，从 controller configmap 运行时探测）
```

**真理源划分**：
- 工作流内容（模板、运行、cron）的真理源是**集群里的 Argo CRD**，argonaut 不复制一份自己的模型。
- argonaut 自有 PG 只存：授权数据、审计日志、模板修订历史（§3.6）。

与两个参考项目的关系：

| | dflow | xyflow | argonaut |
| --- | --- | --- | --- |
| 编辑器 | 有，自有模型编译成 Argo | 无 | 有，直接编辑 WorkflowTemplate |
| 控制台 | 简版实例页 | 完整，对齐官方 | 移植 xyflow |
| 列表性能 | — | 每次全量读 namespace（约 10s / 2k workflows） | informer 内存索引（§2.3） |
| 授权一致性 | — | OPA 内存数据加 TTL 轮询，多副本存在窗口期 | 全局 revision，强一致（§4.3） |
| 部署 | server + nginx 两个镜像 | 同左 | 单镜像（UI 用 `embed.FS` 内嵌） |

## 2. 仓库与后端

### 2.1 目录结构

```
argonaut/
  server/                  Go module `argonaut`
    api/v1/*.proto         接口契约（唯一真理源，buf 生成 Go / HTTP / swagger）
    cmd/                   cobra：server / migrate
    db/migration/          goose 迁移
    internal/
      service/             HTTP service；proto ↔ biz；SSE / 下载 handler
      biz/                 用例层：鉴权入口、编排、审计、版本历史
      data/                pgx 仓储：grants / policies / audit / revisions / 副本心跳
      authz/               Cedar 引擎、内置角色策略、快照与 revision 同步
      oidc/ viewer/        从 xyflow 照搬
    pkg/argo/              从 xyflow 移植：clientset、操作、日志回退、产物、offload、lint；cache.go 为 informer 缓存
    web/                   //go:embed web/dist（ui 构建产物）
  ui/                      React SPA（pnpm）
  deploy/helm/             单 chart：Deployment、SA + RBAC、ConfigMap
  Makefile                 根目录统一入口：make api / gen / dev / build / image
  DESIGN.md
```

单仓的收益：proto 改动、server 实现、UI 类型在**一个提交**里同步，dflow 的“两仓必须协调发布”问题消失。

### 2.2 技术栈（与 xyflow 对齐）

- Go 1.26、Kratos v3、Wire、pgx + goose + PostgreSQL、slog（表少且查询简单，手写 SQL 比 Ent 的代码生成更直接）
- `github.com/argoproj/argo-workflows/v4 v4.1.0`、client-go 0.35
- 授权：`github.com/cedar-policy/cedar-go`（§4.2）
- **JSON 编码**：proto 直接引用 Argo 的 `generated.proto` 消息类型，响应统一用 `encoding/json` 编码（`internal/server/encoder.go`）。生成的 Go 结构体带 lowerCamelCase 的 json tag，Argo 对象按其自身的 JSON 形态输出，避开了 protojson 无法处理 Argo 自定义标量的问题（xyflow 踩过：会 panic）
- **v4 要求 context 带 logger**：沿用 xyflow `pkg/argo.WithClients` 统一注入

### 2.3 informer 缓存（相对 xyflow 的主要改进）

xyflow 的列表每次全量分页读 namespace 再排序，延迟在 10s 量级；Watch 每次打开都会重放全部对象。argonaut 在 server 内维护共享缓存：

- 每个受管 namespace 起 Workflow / WorkflowTemplate / CronWorkflow 的 SharedInformer；ClusterWorkflowTemplate 另起一个集群级 informer。
- **Workflow 用 `SetTransform` 剥离 `status.nodes`**，缓存只保留列表需要的摘要（phase、起止时间、progress、message、labels、templateRef），控制内存；详情页单独 Get 完整对象（并合并 offload）。
- 维护按 `creationTimestamp` 倒序的索引；List = 内存过滤 → 授权过滤 → offset 分页，毫秒级。
- Watch SSE 由 informer 事件扇出给各连接，每个事件按连接用户做授权判定（判定结果按 `(user, revision, resourceKey)` 缓存）。
- 详情页的单对象 Watch 仍用 fieldSelector 直连 K8s，拿完整 status。

### 2.4 API 面

| Service | 方法 |
| --- | --- |
| `AuthService` | Redirect / Callback / UserInfo |
| `InfoService` | GetInfo（版本、受管 namespace、offload / 归档是否启用、外链） |
| `WorkflowService` | List / Get / Watch(SSE) / PodLogs(SSE) / Events / Submit / Retry / Resubmit / RetryNode / Suspend / Resume / Stop / Terminate / Delete / ArtifactDownload |
| `WorkflowTemplateService` | List / Get / Create / Update / Delete / Lint / ListRevisions / GetRevision / Rollback / ListComponents（同时返回 namespace 级和集群级组件） |
| `ArchivedWorkflowService` | List / Get / Delete / Resubmit / Retry / Logs(SSE)，按 UID 寻址（名字可能被后来的运行复用）；另有原始下载路由 `/api/v1/archived-artifacts/{uid}/{nodeId}/{name}`。列表在授权过滤之后分页（逐批扫描归档表），continue token 是归档内的偏移 |
| `ClusterWorkflowTemplateService` | List / Get / Create / Update / Delete / Lint / ListRevisions / GetRevision / Rollback |
| `CronWorkflowService` | List / Get / Create / Update / Delete / Suspend / Resume / RunNow / Lint |
| `AuthzService` | ListGrants / CreateGrant / DeleteGrant / ListRoles / MyPermissions / Check（批量） / ListAudit |

Argo 对象按其 CRD 的 JSON 原样透传（§2.2）；UI 侧 Argo 类型由 Argo 官方 JSON Schema 生成（`scripts/gen-argo-types.mjs`，json-schema-to-typescript → `ui/src/api/gen/argo.gen.ts`，schema 本身也随包提供给 ajv 与 monaco-yaml）。自有 DTO 由 `pnpm gen:api`（`scripts/gen-api-types.mjs`）直接从 `server/api/v1/*.proto` 生成到 `ui/src/api/gen/api.gen.ts`：生成器按响应实际的 JSON 形态输出（encoding/json + protoc-gen-go 的 `omitempty` tag ⇒ 字段名照抄 proto、int64 为 number、所有字段可选），Argo 消息映射到 UI 自己的 Argo 类型。没有用 protoc-gen-es：proto 引用了 Argo 的 gogo `generated.proto`，它会把整个 Argo/K8s 类型树一起带进前端，且其 JSON 形态是 protojson 的，与服务端实际编码不符。`api/types.ts` 在生成类型之上只补服务端保证的不变量（`Present<…>` 标出必有的 ID/时间戳，角色等字符串收窄为联合类型）。CI 重新生成并检查无差异。

## 3. 可视化编排器

### 3.1 核心原则：WorkflowTemplate 本身就是模型

- 编辑器加载的是集群里的 WorkflowTemplate 对象，画布是它的**投影**。
- 画布编辑以**最小补丁**形式写回 spec 对象（改哪个 task 就只动那个 task），从不整体重新生成。因此编辑器不认识的字段（`hooks`、`synchronization`、`podSpecPatch`、`memoize` 等）原样保留。
- YAML 视图（Monaco）与画布双向同步：改 YAML → 重新投影；改画布 → 补丁写回 → YAML 刷新。解析失败时画布冻结并提示，不丢数据。
- 布局坐标存在注解 `argonaut.io/layout`（JSON：`{templateName: {taskName: [x, y]}}`），没有坐标时用 elkjs 自动布局。

### 3.2 Argo spec ↔ 画布映射

| Argo | 画布 |
| --- | --- |
| `spec.entrypoint` 指向的 `dag` 模板 | 主画布 |
| `dag.tasks[]` | 节点 |
| `depends` / `dependencies` | 边；`depends` 里的条件（`A.Succeeded`、`B.Failed`、`\|\|`）显示为边标签，复杂表达式在节点表单里编辑 |
| task 的 `template` 指向 container / script / containerSet / resource / http / data / plugin / suspend 模板 | 对应类型节点，图标与表单按类型切换（交互参考 dflow 的 widget 表单；字段全集见 §3.7） |
| task 的 `template` 指向嵌套 `dag` 模板 | 分组节点，可折叠，或双击进入子画布 |
| task 的 `templateRef`（含 `clusterScope: true`） | 组件节点（§3.3），表单只读显示被引用模板，可跳转；集群级模板带“集群级”角标 |
| `when`、`withItems` / `withParam`、`continueOn`、`retryStrategy` | 节点角标加表单字段 |
| `steps` 模板 | 分组节点，按步骤组渲染（组间串行、组内并行）；表单中编辑步骤组，双击进入子画布 |
| `spec.onExit` 指向的模板 | 画布底部单独的“退出处理”泳道，不参与 DAG 连线 |
| `spec.arguments.parameters` | 画布侧栏“工作流参数”面板 |

### 3.3 组件库（替代 dflow 的 Widget）

- 组件 = 打了 `argonaut.io/component: "true"` 标签的 WorkflowTemplate 或 ClusterWorkflowTemplate；图标、分类、描述放注解。组件本身也是普通模板，同一套权限和编辑器。
- 集群级组件跨 namespace 共享，适合平台团队提供的公共步骤；组件面板按“本命名空间 / 集群级”分组，拖入集群级组件时生成 `templateRef.clusterScope: true`。
- 从组件面板拖入画布时选择两种语义：
  - **引用**（默认）：生成 `templateRef`，组件更新后自动生效；
  - **内联快照**：把组件的模板复制进当前 spec（等价于 dflow 的值语义快照），用于锁定版本。Argo 的 `templateRef` 没有版本概念，需要锁版本就用这种方式。
- Lint 时检查当前用户对所有被引用组件有 `template:get` 权限，防止通过引用间接读取无权模板。

### 3.4 参数与表达式

- task 参数输入框提供补全：`{{workflow.parameters.*}}`、`{{inputs.parameters.*}}`、上游 task 的 `{{tasks.X.outputs.parameters.*}}` / `artifacts.*`。上游输出取自被调模板**原生声明的 outputs**（dflow 缺少 outputParameters 的问题在这里天然不存在）。
- 引用了非上游 task 的输出时就地标红（Argo 运行时才会报这个错）。

### 3.5 保存、校验、运行

1. **Lint**：server 用 `workflow/validate` 校验，会解析集群内的 templateRef；错误定位回节点并高亮。
2. **保存**：先跑服务端 Lint，再带 `resourceVersion` 做乐观锁写入；冲突（409）时进入三方合并页（基线 = 编辑器加载时的版本，对方 = 集群最新，我的 = 当前文档）。不重叠的修改自动合并，重叠处逐条选择“采用对方 / 采用我的 / 手动编辑”，全部解决后以对方的 `resourceVersion` 校验并保存；合并期间若又被修改，基于最新版本重新合并。
3. **试运行**：编辑器内直接提交（填参数表单），跳到运行详情页。
4. **运行视图复用画布组件**：运行详情页的图与编辑器共用同一套节点渲染器；运行视图从 `status.nodes` 构建（含 withItems 展开、重试组），并支持“设计视图 / 运行视图”切换，在设计视图上叠加各 task 的最新状态。

### 3.6 模板修订历史

K8s 不记录“谁改了什么”（所有写操作都是平台 SA 发起），因此每次经 argonaut 的 Create / Update 成功后写一条 `template_revisions`（scope：namespace / cluster、namespace（集群级为空）、name、uid、resourceVersion、完整 spec、作者、说明、时间），并给对象打注解 `argonaut.io/last-modified-by`。

UI 提供修订列表、任意两版 diff、回滚（回滚 = 用旧 spec 发一次 Update，同样带乐观锁，并产生新修订）。

**GitOps（首版不做，预留）**：首版不识别 GitOps 托管标记，所有模板都可在 argonaut 里编辑。为以后接入预留三点：

1. 授权按 `namespace/name` 绑定（§4.3），GitOps 删除重建后授权仍有效；
2. informer 检测到不经 argonaut 的修改时，也记一条作者未知的修订，所以能看出 Git 同步覆盖了什么；
3. 所有编辑入口都走同一个 `editable(template)` 判定，以后加“托管模板只读 / 导出 YAML / 生成 PR”只改这一处。

### 3.7 节点类型与配置项

**目标：Argo 模板里能设置的字段，在表单里都能设置**，不需要退回 YAML。没有专门控件的字段（亲和性、lifecycle、podSpecPatch 等）用内嵌的 YAML 小编辑器，但仍然是表单里的一项，并标出它对应的字段路径。

**节点类型**（组件面板按“执行 / 控制 / 组件”分组）：

| 类型 | 是否创建 Pod | 专属配置 |
| --- | --- | --- |
| Container | 是 | image、imagePullPolicy、command、args、workingDir、env / envFrom、resources、volumeMounts、securityContext、ports、探针、lifecycle、终止消息、stdin/tty |
| Script | 是 | Container 的全部字段 + source |
| ContainerSet | 是（一个 Pod 多个容器） | containers（每个是完整容器 + dependencies）、共享 volumeMounts、容器集内部 retryStrategy（retries、duration） |
| Resource | 是（executor） | action、mergeStrategy、manifest / manifestFrom、setOwnerReference、flags、successCondition、failureCondition |
| HTTP | 否（Agent） | method、url、headers（value / secretKeyRef）、body / bodyFrom、timeoutSeconds、successCondition、insecureSkipVerify |
| Data | 是 | source.artifactPaths、transformation（expression 序列） |
| Plugin | 否（Agent） | 插件名（来自控制器启用的 executor plugins）+ 插件自定义配置 |
| Suspend | 否 | duration；Resume 时填写的参数在输入输出里以 supplied 声明 |
| DAG（嵌套） | 否 | target、failFast、tasks（子画布） |
| Steps | 否 | 步骤组（组间串行、组内并行，子画布） |
| 组件引用 | 由被引用模板决定 | templateRef.name / template / clusterScope、引用或内联快照；被引用模板的配置只读 |

**配置面板**：选中节点后，右侧面板按六个页签组织，每个字段同时显示中文名和 Argo 字段路径，顶部可以按名称或路径搜索：

| 页签 | 内容 | 适用 |
| --- | --- | --- |
| 任务 | DAG task / step 级字段：name、template / templateRef / inline、depends、when、withItems / withParam / withSequence、arguments（parameters、artifacts）、continueOn、onExit、hooks | 所有 DAG / Steps 中的节点；退出处理模板只显示说明 |
| 〈类型〉配置 | 上表的专属配置 | 按类型 |
| 输入输出 | inputs.parameters / artifacts、outputs.parameters / artifacts（列表中每一项都能编辑全部子字段），以及 result / exitCode 说明 | 组件引用只读 |
| Pod | metadata、nodeSelector、tolerations、affinity、schedulerName、priorityClassName、serviceAccountName、automountServiceAccountToken、executor、securityContext、volumes、initContainers、sidecars、hostAliases、podSpecPatch、archiveLocation | 创建 Pod 的类型；HTTP / Plugin 只有 metadata；其余显示“不创建 Pod” |
| 策略 | retryStrategy（limit、retryPolicy、expression、backoff、affinity）、timeout、activeDeadlineSeconds、memoize、synchronization（mutexes、semaphores）、metrics；按类型追加 parallelism、failFast、daemon | Suspend 不显示重试；组件引用只读 |
| YAML | 当前节点对应的 task + template 片段，与表单、画布双向同步 | 全部 |

**工作流设置**（点画布工具栏的“工作流设置”或画布空白处）编辑 spec 级字段，分四个页签：

- 基本：entrypoint、arguments、serviceAccountName、activeDeadlineSeconds、onExit、hooks、priority、workflowMetadata；
- 清理与归档：ttlStrategy、podGC、archiveLogs、artifactRepositoryRef、artifactGC；
- Pod 默认值：podMetadata、nodeSelector、tolerations、affinity、schedulerName、podPriorityClassName、podDisruptionBudget、imagePullSecrets、executor、securityContext、hostNetwork、dnsPolicy、dnsConfig、hostAliases、volumes、volumeClaimTemplates、volumeClaimGC、templateDefaults、podSpecPatch；
- 并发与指标：parallelism、synchronization、retryStrategy、metrics。

**字段清单的来源**：表单定义由 Argo 仓库里与所用版本（v4.1.0）对应的 JSON Schema（`api/jsonschema/schema.json`）生成骨架，再手工补中文名、分组、控件类型和说明。升级 Argo 版本时对比 schema，新增的字段若没有手工定义，会自动落到对应页签末尾的“其他字段”里，保证不会漏。

## 4. 登录与授权

### 4.1 登录

照搬 xyflow / dflow 的 OIDC 流程：code → 校验 id_token → 用 HS256 自签 JWT 下发给 UI，IdP 的 token 不进浏览器。用户标识锚定 `sub`。首版只做用户级授权，不读 `groups` claim。

### 4.2 授权模型与策略语言：Cedar

不沿用 OPA 的原因：OPA 要求把数据整体加载到引擎内存，一致性只能靠轮询刷新，这正是 xyflow 在多副本下存在窗口期的根源。**Cedar**（AWS 开源，有官方 Go 实现 `cedar-go`）更适合这里：

- 实体与关系**按请求传入**，引擎本身无状态，数据新鲜度完全由我们控制；
- 有 schema 校验，策略可做静态分析（例如“是否存在能让 viewer 删除的路径”）；
- 原生覆盖 RBAC + ABAC，后续加“生产 namespace 禁止 terminate”这类规则只需写一条 forbid 策略。

`internal/authz` 定义 `Engine` 接口，Cedar 是唯一实现；若以后要换（例如需要 Zanzibar 式关系模型时换 OpenFGA），不影响业务层。

**模型**（在 xyflow 基础上扩展）：

- 主体：`User::"<sub>"`。首版不支持组；以后接入时，在 Cedar 里加 `Group` 实体，并按请求传入用户所属的组即可，grants 表与策略结构不用改。
- 资源层级：
  - `Global` ⊃ `Namespace::"ns"` ⊃ `Template::"ns/name"`；
  - `Global` ⊃ `ClusterTemplate::"name"`。集群级模板不属于任何 namespace，namespace 级授权覆盖不到它。
  - Workflow / CronWorkflow 的归属见 §4.4。
- 角色（内置，动作集固定）：

| 角色 | 动作 |
| --- | --- |
| `viewer` | template:get/list；workflow:get/list/logs/artifacts/events；cron:get/list |
| `operator` | viewer + workflow:submit/retry/resubmit/suspend/resume/stop/terminate/delete；cron:suspend/resume/run |
| `editor` | operator + template:create/update/delete；cron:create/update/delete |
| `admin` | editor + authz:grant/revoke（只能授权到自己有 admin 的范围内） |

对 `ClusterTemplate` 的授权只作用于模板定义本身（template:\* 与 authz:\*），不会经由它授予 workflow:\* 动作（理由见 §4.4）。

- 内置策略文件随代码发布（`internal/authz/policies/*.cedar`）；自定义 forbid/permit 策略可存 DB，与 grants 共享同一个 revision（§4.3），保证“策略 + 数据”一起原子变更。
- 超级管理员走配置文件 bootstrap，不依赖 DB（xyflow 的经验：DB 故障时不能把修复它的人锁在外面）。

### 4.3 一致性保证（重点）

目标：**任何副本、任何时刻的判定都基于最新已提交的授权数据**；撤权立即生效；UI 展示的权限与服务端执行的权限出自同一引擎。

**单一真理源加全局 revision**：

```
grants(id, subject_type, subject, resource_type, namespace, name, role, created_by, created_at)
authz_policies(id, body, enabled, created_by, created_at)        -- 自定义策略
authz_meta(id=1, revision bigint)                                -- 全局单调版本号
audit_events(id, actor, action, resource, detail jsonb, revision, at)
```

`grants.resource_type` 取值 `global` / `namespace` / `template` / `cluster_template`；`cluster_template` 行的 namespace 为空。

**写路径**（同一个 PG 事务内完成）：

```
BEGIN;
  校验发起者对目标范围有 authz:grant（基于本事务内读到的数据判定）
  INSERT/DELETE grants (或 authz_policies)
  UPDATE authz_meta SET revision = revision + 1 RETURNING revision;
  INSERT audit_events (..., revision);
  SELECT pg_notify('argonaut_authz', revision);    -- 提交时才会投递
COMMIT;
→ 响应里返回新 revision
```

**读路径（每次判定）**：

1. 每个副本内存里有快照 `{revision, grants 索引, 已编译策略}`。
2. 收到 NOTIFY 时异步重载快照（常规路径，毫秒级）。
3. **每个请求先读一次 `authz_meta.revision`**（主键单行查询，亚毫秒级）。快照落后就**同步重载后再判定**。因此即使 NOTIFY 丢失或 LISTEN 连接断开，也不会用过期数据放行。
4. 客户端带 `X-Authz-Revision`（取自最近一次授权写操作或 MyPermissions 的响应）；服务端快照低于它时同样先重载，保证管理员“授权后立刻能用”的读己所写。
5. 读 revision 失败（DB 不可用）时**拒绝**（超级管理员除外），不降级为放行。

**长连接**：SSE 流（列表 Watch、日志）订阅快照变更；revision 变化时对该连接的主体重新判定，被撤权的流直接关闭，列表里已推送的对象发送 DELETED 事件移除。

**UI 与服务端一致**：UI 不自己推导权限。按钮显隐来自 `MyPermissions` / 批量 `Check`，响应带 revision；TanStack Query 以 revision 作为缓存键的一部分，收到更新的 revision 时自动失效。

**授权数据与集群资源的一致**：

- grants 以 `namespace/name` 绑定模板，而非 UID，这样 GitOps 删除重建后授权仍然有效。代价是同名重建会继承旧授权，这里明确接受。
- 经 argonaut 删除模板时，先删 K8s 对象，再在事务里删对应 grants；PG 失败则留给后台对账清理。
- 后台对账任务（基于 informer）把指向不存在模板的 grants 标为“孤儿”，在授权管理页展示，由管理员决定删除。不自动删除，避免 GitOps 短暂删除导致授权丢失。

### 4.4 关联资源的归属与防伪造

- Workflow 归属：label `workflows.argoproj.io/workflow-template` → 对应模板；无此 label → 归属 namespace 范围。CronWorkflow 同理（`workflowTemplateRef`）。
- **来自 ClusterWorkflowTemplate 的 Workflow / CronWorkflow 归属所在的 namespace**（label `workflows.argoproj.io/cluster-workflow-template`，或 `workflowTemplateRef.clusterScope: true`）。集群级模板通常是平台提供的公共流程，各团队在自己的 namespace 里运行。如果让集群模板的授权直接覆盖它跑出的所有 Workflow，一条授权就能操作所有 namespace 里的运行。因此：
  - 编辑模板定义：看对 `ClusterTemplate` 的授权；
  - 提交：需要目标 namespace 的 `workflow:submit`，**并且**对该集群模板有 `template:get`；
  - 之后对这次运行的所有操作：只看 namespace 的授权。
- 集群级模板默认对所有登录用户可读（配置 `authz.clusterTemplatesReadable: true`，对应一条内置 permit 策略），因为它们本来就是共享构件；可以关掉，改为按授权查看。
- **防伪造**：通过 argonaut 提交的原始 YAML，server 会**剥离并重写**该 label，防止用户给自己的 workflow 伪造来源模板来借用别的模板的权限。原始 YAML 提交要求 namespace 级 `workflow:submit`。（集群外 kubectl 创建的 workflow 照常信任 label，因为对方本就有集群权限。）
- 所有写操作记录 `audit_events`，在 UI 可查。

### 4.5 执行点

1. 操作类接口：biz 入口 `authz.Require(ctx, action, resource)`，拒绝返回 403。
2. 列表 / Watch：informer 数据先授权过滤再分页（先分页再过滤会给只能看部分数据的用户返回残缺页，xyflow 已踩过）。
3. 授权管理接口自身也走同一引擎（`authz:grant`）。
4. UI 显隐只是体验，不是安全边界。

## 5. UI

### 5.1 技术栈

基线与 dflow-ui 相同（React 19 + Vite 7 + shadcn/ui + TanStack Query），但**收敛依赖**：dflow-ui 同时装了 emotion、jotai、framer-motion、ramda、react-use 和五套图标库，argonaut 每个领域只保留一个库。

| 领域 | 选型 | 说明 |
| --- | --- | --- |
| 构建 | Vite 7、React 19、TypeScript 5.9（strict）、pnpm | `@vitejs/plugin-react-swc`；构建产物输出到 `server/web/dist`，由 Go embed |
| UI 组件 | **shadcn/ui**（new-york 风格，Radix 基座）+ Tailwind CSS 4 + tw-animate-css | 约定见 §5.3 |
| 图标 | lucide-react | 唯一图标库，与 shadcn 默认一致 |
| 路由 | TanStack Router（文件路由、自动代码分割） | 选型理由见 §5.2 |
| 服务端状态 | TanStack Query 5 | 路由 loader 中预取；SSE 事件直接写入 query 缓存（§5.5） |
| 客户端状态 | Zustand 5 + immer | 会话、偏好、编排器文档；不引入 jotai |
| 表单 | 受控组件 + zod 4 | 现有表单（提交、授权、策略…）字段少，受控组件足够，未引入 react-hook-form；zod 用于 URL 搜索参数；编排器配置面板直接绑定文档（§5.4） |
| 表格 | shadcn Table | 列表由服务端分页、过滤，前端无需 TanStack Table 的列模型 |
| 虚拟滚动 | TanStack Virtual | 日志（可达几十万行）、长列表、大 diff |
| 图 | @xyflow/react 12 + elkjs | 编辑器与运行视图共用；elk 跑在 Web Worker 里，原生支持分组和嵌套 |
| 代码编辑 | Monaco（@monaco-editor/react）+ monaco-yaml | YAML 编辑接入 Argo JSON Schema，实现补全和即时校验；DiffEditor 用于修订对比 |
| YAML | yaml（eemeli）Document API | 保留注释和键顺序，支持对文档做最小修改 |
| 三方合并 | 自研结构化合并（`editor/merge.ts`） | 按键合并对象、按 name 合并列表（templates / tasks / parameters / env…），不同任务上的修改即使在 YAML 里相邻也不冲突；比按行的 diff3 更贴合模板结构 |
| 结构校验 | ajv（Argo JSON Schema）、zod 4（表单与 URL 参数） | |
| HTTP | ky | 统一注入 Authorization、`X-Authz-Revision`，归一化错误 |
| SSE | @microsoft/fetch-event-source | 浏览器 EventSource 不能带 Authorization（xyflow 为此手写了解析器）；该库负责分帧、重连和 Last-Event-ID |
| 时间与 cron | date-fns 4、cronstrue（zh_CN） | cron 的下次运行时间由服务端计算，保证与控制器一致；前端只把表达式翻成中文描述 |
| 日志渲染 | anser | ANSI 颜色 |
| 国际化 | i18next + react-i18next | zh-CN / en，语言包随构建打包 |
| shadcn 生态 | sonner、cmdk、react-resizable-panels | 提示、表达式补全、可拖宽面板 |
| 测试 | Vitest 3、Playwright | Vitest 覆盖编排器的纯逻辑（ops、merge、lint、文档补丁）；Playwright 冒烟（`ui/e2e`，`pnpm e2e`）跑在真实 server + 集群上：列表/详情/日志、编排器新建/编辑/Lint/保存、三方合并、模板详情与修订、归档、权限页、中文界面；用本机 Chrome，测试自建并清理 `e2e-` 前缀的模板。需要集群，故不进 CI |
| 规范 | ESLint 9（flat config）+ typescript-eslint + react-hooks、Prettier | CI 执行 lint、typecheck、test |

**明确不用**：emotion（全部 Tailwind）、framer-motion（tw-animate-css 与 CSS 过渡足够）、jotai、ramda、react-use、dagre、shiki（Monaco 已覆盖高亮）、nuqs（TanStack Router 已覆盖 URL 状态）、除 lucide 外的图标库。

### 5.2 路由与页面

选 **TanStack Router** 而不是 dflow 用的 React Router 7，原因是 argonaut 有大量页面状态放在 URL 里：列表筛选、详情页的 `tab / nodeId / artifact / retries`、编排器选中的节点和页签。TanStack Router 的 search params 用 zod 声明，读写全程有类型，不用手工序列化；React Router 7 要再加 nuqs，类型也得自己维护。loader 与 TanStack Query 的配合方式（`queryClient.ensureQueryData`）与 xyflow 的预取思路一致。代价是与 dflow 的写法不同，需要熟悉一下。

| 路由 | 内容 |
| --- | --- |
| `/workflows`、`/workflows/:ns/:name` | 列表（过滤、批量操作、实时刷新）与详情（全量对齐官方，移植 xyflow） |
| `/templates`、`/templates/:ns/:name` | 列表；详情含 DAG 预览、参数、YAML、修订历史、该模板的运行记录、Submit |
| `/templates/new`、`/templates/:ns/:name/edit` | **编排器** |
| `/cluster-templates`、`/cluster-templates/:name`（`/edit`） | ClusterWorkflowTemplate：列表、详情、编排器，复用 namespace 级模板的全部页面，只是不带 namespace |
| `/components` | 组件库浏览（带标签的模板），可一键新建组件 |
| `/crons`、`/crons/:ns/:name` | 列表、详情、Suspend/Resume/Run Now（移植 xyflow） |
| `/admin/authz`、`/admin/audit` | 授权管理（grants、孤儿授权、我的权限、角色说明）、审计日志 |

URL 状态沿用 xyflow 的约定（`?tab=&nodeId=&artifact=in|out:<nodeId>/<name>`），每个路由用 zod 定义自己的 search schema，刷新和分享链接都不丢上下文。

### 5.3 shadcn 使用约定

- `components.json`：style `new-york`、baseColor `zinc`、`cssVariables: true`、iconLibrary `lucide`；`--primary` 设为页面设计里的靛蓝。
- `components/ui/` 是 vendored 的 shadcn 源码：只允许调整样式 token，不写业务逻辑；需要业务变体时在 `components/common/` 里封装。升级时用 shadcn CLI 的 diff 合并。
- **主题 token** 全部定义在 `index.css` 的 CSS 变量上，分亮、暗两套。除 shadcn 标准变量外，再加三组 argonaut 自有变量：
  - 运行状态色：`--phase-succeeded / running / failed / pending / suspended`（各含前景和背景）；
  - 合并差异色：`--diff-mine / theirs / conflict`；
  - 节点类型色：`--node-container / script / …`。

  业务代码只引用这些 token，不直接写色值，暗色模式因此不用逐页适配。
- **会用到的 shadcn 组件**：button、input、textarea、select、checkbox、switch、radio-group、label、form、tabs、toggle-group（分段切换）、dialog、alert-dialog、sheet、popover、dropdown-menu、command、tooltip、badge、card、alert、table、pagination、breadcrumb、separator、scroll-area、resizable、collapsible、accordion（配置分组）、skeleton、calendar、sonner。
- **在 shadcn 之上的业务组件**（`components/common/`）：

| 组件 | 用途 |
| --- | --- |
| PhaseBadge、Duration、Progress | 运行状态徽章（图标加颜色，不只靠颜色）、耗时、进度 |
| ResourceName | 等宽字体显示资源名，带复制按钮 |
| NamespaceSwitcher | 顶栏 namespace 切换 |
| PermissionGate | 按 MyPermissions 控制显隐或禁用，并给出原因 |
| ConfirmAction | 危险操作的二次确认，Terminate、Delete 要输入资源名 |
| KeyValueEditor、ListEditor、ObjectListEditor | 配置面板里的 kv、列表、对象列表控件 |
| ExpressionInput | 输入 `{{` 时用 cmdk 弹出补全 |
| YamlEditor、YamlDiff | Monaco 封装，懒加载，不进首屏包 |
| LogViewer | 虚拟滚动、ANSI 着色、grep 过滤、跟随 |

### 5.4 编排器的前端结构

- **文档模型**：编排器 store（Zustand + immer）持有当前模板的 `yaml.Document` 和由它派生的 JS 对象。每次编辑都表示为一组 JSON Patch（immer `produceWithPatches`），同时应用到 Document 上，因此注释和键顺序都能保留。撤销 / 重做就是应用逆向 patch，“N 处未保存”的计数也来自 patch 历史。
- **三个视图只经过 store**：画布、配置面板、YAML 都只读 store 并派发 patch，彼此不直接通信。在 YAML 里改动时先解析，成功后计算差异 patch；解析失败时冻结另外两个视图（§3.1）。
- **配置面板是 schema 驱动的渲染器**，不用表单库，因为表单状态就是文档本身：
  - 字段描述来自 Argo JSON Schema 生成的骨架，加上手写覆盖（中文名、所属页签、控件类型、说明），见 §3.7；
  - 控件注册表：text、number、select、switch、kv、list、object-list、resources、expression、yaml-snippet；
  - 每个控件直接绑定文档路径，输入防抖或失焦时写 patch。
- **校验分两层**：
  - 本地用 ajv 按 Argo JSON Schema 即时校验，错误标在字段上；
  - 服务端 Lint 在保存前或手动触发时运行，结果映射回节点和字段。
- **性能**：React Flow 节点组件 memo 化；store selector 按路径精确订阅；elk 布局放在 Worker 里，不阻塞输入。验收时用数百个 task 的模板做压测。

### 5.5 数据获取与实时更新

- **API 层**：`api/<domain>/` 导出 queryOptions 工厂（如 `workflowQueries.detail(ns, name)`）和 mutation hooks。ky 实例统一处理错误：
  - 401 → 跳转登录；
  - 403 → 显示无权限及原因；
  - 409 → 交给编排器的冲突合并流程。
- **类型来源**：
  - Argo 对象由 `pnpm gen:argo` 从 v4.1.0 的 JSON Schema 生成（`api/gen/argo.gen.ts`），schema 同时供 ajv 和 monaco-yaml 使用；
  - 自有 DTO 由 `pnpm gen:api` 从 proto 生成（`api/gen/api.gen.ts`，见 §2.4），`api/types.ts` 只在其上补不变量；
  - 生成的文件提交进仓库。
- **SSE**：统一走 `lib/sse.ts` 的 `streamEvents`（fetch-event-source），事件写入对应 query 的缓存。effect 只依赖 path，不依赖缓存：xyflow 曾因 effect 依赖缓存，导致每个事件都重连一次（STATUS.md bug #6）。列表 Watch 只请求列表需要的字段。
- **授权 revision**：响应头里的 `X-Authz-Revision` 存进 session store。`MyPermissions` 的 query key 包含 revision，revision 一变化就自动重新获取（§4.3）。

### 5.6 目录结构

```
ui/
  components.json
  src/
    routes/          TanStack Router 文件路由：__root、workflows、templates、cluster-templates、crons、components、admin
    api/
      gen/           生成的类型：argo.gen.ts、argonaut/*_pb.ts
      <domain>/      queryOptions、mutations
    components/
      ui/            shadcn（vendored）
      common/        业务组件（§5.3）
    graph/           画布内核：model（spec→graph、status→graph）、layout（elk worker）、nodes、edges
    editor/          编排器：store、fields（schema、覆盖、控件）、panels、merge
    workflow/        运行详情：各页签、节点面板、日志、产物、时间线
    lib/             http、sse、authz、format、i18n、theme
  e2e/               Playwright 冒烟（真实 server + 集群）
    stores/          session、preferences
    locales/         zh-CN（英文原文即 key）、en（仅单数形式）
```

## 6. 配置与部署

- 配置按 kratos-scaffold 的约定分层（后者覆盖前者）：编译进二进制的 `server/configs/default/config.yaml`（安全默认值：不启用 IdP、没有开发身份）→ Git 忽略的 `server/configs/local/`（个人覆盖，从 `configs/local.example.yaml` 复制）→ `--config` 指定的文件或目录（Helm 挂载的 ConfigMap、`configs/dev-archive`）→ `ARGONAUT_*` 环境变量（填充 `${DATABASE_URL}`、`${JWT_SECRET}`、`${SSO_CLIENT_SECRET}` 占位符），由 `kratos-kit/config/loader` 加载。配置项：`server`、`data.database`、`sso`、`kube`（kubeconfig/in-cluster、**显式 `context`**、受管 namespace 列表；单集群）、`argo`（controller configmap 位置、instanceId）、`authz`（superAdmins、devSubject、pollInterval、`clusterTemplatesReadable`）。
- 单镜像：UI 构建产物通过 `embed.FS` 进入二进制，server 负责 SPA fallback。
- 归档：与 argo-server 一样，从控制器 ConfigMap 的 `persistence` 段发现归档库（只读，不做迁移）；`persistence.archive` 为真时 UI 出现“归档”入口。本地开发用 `configs/dev-archive`：它读取 `argonaut-dev-controller-configmap`（真实 ConfigMap 的副本 + 指向本机 Postgres 的 persistence 段），用 `go run ./hack/archive-seed` 把集群里已结束的运行写入归档，不改动集群里的控制器。
- Helm chart：Deployment（可多副本，一致性由 §4.3 保证）、SA + ClusterRole（含 clusterworkflowtemplates 读写）+ 各受管 namespace 的 RoleBinding（Argo CRD 读写、pods/log、events、configmap/secret 读）、PG 连接 Secret。

## 7. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M0 | monorepo 脚手架：proto 生成链（Go + TS）、Argo swagger 生成 TS、embed 单二进制、helm、CI | `make build` 产出单镜像，起来能访问 SPA |
| M1 | OIDC、informer 缓存、Workflows 列表与详情（移植 xyflow，含日志回退、产物、offload） | 2k+ workflows 的 namespace 列表 < 200ms |
| M2 | 授权：Cedar 引擎、grants/revision/NOTIFY、Watch 重判、授权管理页、审计 | 双副本下授权/撤权立即在另一副本生效；断开 LISTEN 后仍不放行过期权限 |
| M3 | Templates（含 ClusterWorkflowTemplate）/ Crons 列表详情、提交面板、全部操作（移植 xyflow）、修订历史 | 模板提交 → 运行 → 查看全链路 |
| M4 | 编排器 v1：DAG 投影与补丁写回、§3.7 全部节点类型与全字段配置面板、工作流设置、YAML 双向同步、Lint 定位、乐观锁与冲突合并 | 编辑一个手写的复杂模板，未支持的字段保存后不丢失 |
| M5 | 组件库（引用/快照）、参数表达式补全、编辑器内试运行、设计视图叠加运行状态 | 用组件拼出模板 → 运行 → 在设计视图看到状态 |
| M6 | i18n、暗色、归档 workflow、批量操作逐行结果 | — |

### 7.1 实现状态（2026-10-21）

M0–M6 全部实现，并在真实集群上验证：列表与详情（含重试折叠/展开、时间线、日志、产物）、跨副本授权一致性、审计、模板修订（含集群外修改检测）、编排器（全部节点类型、配置面板、YAML 双向同步、本地 + 服务端 Lint、保存冲突三方合并、试运行、最新运行状态叠加、从组件新建）、i18n（zh-CN）、暗色、批量操作逐行结果、workflow 归档（列表、详情、日志、产物、重新提交、重试、删除，均按模板授权并审计）。自有 DTO 类型由 proto 生成。

测试：Go 单测（授权引擎、归档分页与授权）、Vitest（编排器纯逻辑）、Playwright 冒烟 8 例（需真实 server 与集群，本地运行）。

## 8. 已确认的决策（2026-10-21）

1. **单集群、多 namespace**。资源 ID 不带集群维度。
2. **首版只做用户级授权**，不读 IdP 的 groups claim；`subject_type` 留作扩展（§4.2）。
3. **GitOps 首版不做**，但保留按名称绑定授权、记录集群外修订、统一的 `editable()` 判定三个接入点（§3.6）。
4. **支持 ClusterWorkflowTemplate**：独立的资源类型与授权层级；从它跑出的运行归属所在 namespace；默认所有登录用户可读（§4.2、§4.4）。
5. **不从 xyflow 迁移数据**。
6. **前端 UI 用 shadcn/ui，路由用 TanStack Router**（不沿用 dflow 的 React Router 7，理由见 §5.2）。

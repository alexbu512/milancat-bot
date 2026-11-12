# milancat bot

> **English summary.** A Grok-bot-style AI organization inside DeepSeek Harness. A chief-of-staff
> agent lives in the left sidebar: you tell it what you want, it proposes a structure, then creates
> departments, roles and per-department group chats. Each employee is a real child agent on *this*
> machine — it can read and write files, run commands and take screenshots — with one durable agent
> session per person and a `记忆.md` on disk so it remembers its own work. Finished work comes back
> as one summarised message from the assistant, not as a pile of department reports. No cloud VMs,
> no extra service: the plugin is a single `dsh.bundle` (host routes + Web panel) with no
> dependencies and nothing to build.

把 Grok bot 的那套「AI 组织」搬进 DSH 左侧栏：一个总裁助理帮你招部门、招员工、拉部门群，你只对助理说话，它把活分派下去，员工都是**这台电脑上真实运行的 agent**，能读写文件、跑命令、截屏操作，干完把结果汇总回来。

> 只想快点用起来 → 看 [使用手册.md](使用手册.md)。这份 README 讲怎么装、以及它内部是怎么搭的。

## 它和 DeepSeek superagent 的关系

DeepSeek 开源的 superagent（`deepseek-ai/dsh-superagent-prototype`）是**单个交付 agent**：`Source → Trigger → Thread → Eval → Decision → Ticket → Assignment → Executor → Channel`，用 SQLite + 持久化队列保证一个需求从进入到交付不丢步，只在真正需要拍板时才打扰人。

milancat bot 保留这套骨架的纪律（每个任务是一条 Ticket，有状态、有步骤流水、可取消可重试），但把「组织」放在最上面：部门、岗位、职责、部门群才是你要操作的东西——这正是 Grok bot 的核心。差别只在执行层：

| | Grok bot | superagent | milancat bot |
|---|---|---|---|
| 组织模型 | 部门 / 岗位 / 群 | 无 | 部门 / 岗位 / 群 |
| 执行环境 | 每个 agent 一台云电脑 | 一个仓库 | 同一台本机，每个员工一个真实子 agent |
| 触发 | 你下派 | webhook | 你下派（或定时） |
| 成本 | 每 agent 一台 VM | 一个服务 | 0 额外服务器 |

## 安装（另一台机器）

前置：那台机器上已经装好 DSH 并能正常打开 Web GUI。

1. 把这个目录整个拷过去，例如 `D:\plugins\milancat-bot`（`lib/` 必须在里面）。
2. 在 DSH 会话里让 agent 执行，或自己用命令行等价操作：

   ```
   plugin_manager install_bundle target D:\plugins\milancat-bot
   ```

   也可以手动：在 DSH 的 profile 目录里 `pnpm add file:D:\plugins\milancat-bot`，并在 `cordis.patch.yml` 里加

   ```yaml
   - insert:
       - id: dsh-bot
         name: '@local/dsh-bot'
   ```

3. **完全退出并重开 DSH**（`index.js` 与 bundle 清单只在启动时加载）。
4. 左侧栏最下面出现 `bot` 图标，点开就是面板（插件名/包名是 `milancat bot`，栏上那个短标签是 `bot`）。

装好之后不需要再动文件；`lib/engine.js` 是热加载的，改完刷新页面即生效，`client.js` 改完刷新页面生效，只有 `index.js` / `package.json` 需要重启。

## 第一次使用

1. 点开面板，进「助理」页，跟它说你要做什么，例如：
   - 「帮我搭一个做小红书账号的团队」
   - 「我要做短视频带货，帮我配人」
   助理会给你一段说明，并自动建好部门、岗位、职责、技能和每个人的能力提示词。
2. 每个部门会自动有一个部门群。群是**助理派活、部门汇报**的地方，同时你也可以像走进部门一样在群里直接说话（部门照办）。
3. 派活有两条路子，和真实公司一样：
   - **叫助理转达**：你在「助理」页交代，助理判定该给哪个部门（或哪个员工），再以「助理」的身份把任务翻译成部门听得懂的话发进群；一件事该一个部门做就只派一个部门，负责人自己拆给员工；只该一个人干、或你点名了某人，助理就 @ 到那个人；能并行推进的两件独立的事，助理会分派给两个部门，各推一条。
   - **自己进群直接下命令**：在部门群的输入框里直接说，群里显示的就是「老板：…」，部门当场执行——和现实里你绕过助理走过去发话一样。
4. 任务跑起来后点开能看到 `过程 · N 步`：部门负责人怎么拆的、每个员工调了什么工具、写了哪个文件、最后怎么汇总（界面默认不显示过程，见下）。
5. 不满意可以「停止」或「重跑」；随时能编辑员工（姓名、职位、描述、职责、技能、能力提示词、头像）。

## 发文件、发图片

输入框左边有个「＋」，也可以直接把文件拖进对话框、或者粘贴一张截图（Ctrl+V）。上传完会显示成小标签，× 可以去掉，回车连同文字一起发出去。

- 图片：消息里直接显示缩略图，点开看原图；助理和员工都拿到的是**本机真实路径**，可以直接用 `read_image` 看，不用你描述画面。
- 其它文件（文档、表格、代码、音视频）：显示成带名字和大小的标签，同样把绝对路径交给 agent，它能自己打开读。
- 派活的路径也一样：你在助理那里发一张参考图，助理会把这个路径写进任务的 brief，接到活的员工打开的就是这张图。
- 单个文件上限 12MB，存在 `.milancat/files/in/`；**这个上限要重启 DSH 后才完全生效**（旧的请求体上限是 4MB）。

## 定时任务

左边栏「定时」（时钟图标）。**不用装插件**：定时器跑在插件自己的宿主进程里，只要 DSH 开着就有效，不依赖任何会话存活（这点和 harness 自带的 `schedule_create` 不同——那个只往活着的会话里投递提示词）。

- 存 `state.schedules`：`{ id, at:'08:00', days:[0..6], title, brief, mode:'assistant'|'task', deptId, empId, enabled, lastRun, lastAt, skip, lastError }`。
- 引擎里 30 秒一个 tick（`ensureScheduler` 挂在 `SHARED.schedTimer`，任何一次 API 请求都会把它拉起来），按本地时间比对 `at`，`lastRun` 记 `YYYY-MM-DD` 保证一天只跑一次。
- 触发方式两种：`mode:'assistant'` 走 `assistantTurn(..., { from:'schedule' })`，助理自己决定派给谁，结果写进助理对话（飞书绑了也会推到手机）；`mode:'task'` 直接建任务派给指定部门。
- 助理正忙时跳过本次、下一 tick 再试；错过超过 4 小时记 `lastError='这个点电脑没开着，跳过了'` 并把当天标记跑过，避免开机后补跑一堆过期的。
- 接口：`GET /schedules`、`POST /schedules`、`POST /schedules/<id>/{run,toggle,delete}`。

## 并发：不设上限（这些数是我们自己定的，不是 DeepSeek 原型里的）

- **任务**：`SHARED.max = Infinity`（`lib/engine.js:207`）。`dispatchTask` 的排队闸门只在 `Number.isFinite(concurrency.max)` 时才生效，所以现在派几件就同时跑几件；`pumpTasks()` 保留着，将来想限流改成数字即可。
- **一个任务里的员工**：`const WORKER_MAX = Infinity`，一个部门有几个人就几个人并行。
- **45 分钟**：`runAgent({ timeoutMs = 45 * 60 * 1000 })`，到点 abort 掉子 agent 并把任务标失败。

DeepSeek 的 superagent 原型里没有这些数——它一个 Ticket 一个 Executor，靠被动的效果队列驱动，重点是"少打扰人"，不是一个多部门并行干活的调度器。

## 顶上去：任务跑到一半还能补话

老板在一件活**还在跑**的时候发现漏说了、说错了，不该再来一件，而是把那句话塞进**正在跑的那件活**里。

- 引擎：`supplementTask(ctx, root, taskId, text, files)` 把补充记到 `task.addenda[]`，写一条「老板补充：…」的可见步骤（`appendStep`，会同时进部门群），然后 `runAddendum()` 让部门负责人立刻按补充要求再做一段；产出记到 `task.supplements[]`，并以「补充答复」并回交付。任务已经结束就返回 `{ok:false, reason:'finished'}`，由助理改成另派一件「接着改：…」。
- 路由：`POST /tasks/<id>/supplement` `{text, files?}`；`finished/stopped/empty` → 409 带 hint，`not-found` → 404。
- 助理：`assistantTurn` 的提示词里带 `runningDigest(state)`（正在跑的任务：标题/部门/状态/做了多久/id），并新增 JSON 键
  `{"supplement":[{"taskId":"task_xxx","text":"…"}]}`；解析在 dispatch **之前**，因为同一句话既像补话又像新活。
- 界面：任务详情页底部，跑着的任务会显示输入框 + 「顶上去」。
- 交付拼装：主流程收尾时按「基础结果 + 各条补充答复」拼（`lib/engine.js:744-750`）；补充在主流程收尾之后才回来的，由 `runAddendum` 自己补写。

## 助理回话时还能插一句 + 边写边显示

- **插一句**：`POST /assistant` 在 `assistant.busy` 时不再返回 409，而是把这句话立刻写进聊天（`messages`）并压入 `assistant.inbox`，返回 `{ok:true, queued:true, waiting:N}`；`assistantTurn` 收尾时调 `drainInbox()`，取一条、标 `prePushed`（不重复写用户气泡）、再跑一轮，自己会接着排空，所以连插几句也会按顺序一条条答，不会两个回合并发抢同一份上下文。
- **打字预览**：`askModel` 每收到一个 `text-delta` 就写 `SHARED.typing = {text, at}`；`/state` 返回 `typing`（180 秒内有效，否则为空），客户端在聊天流末尾渲染一个带光标的气泡。预览文字经过 `typingPreview()`：遇到 ``` 或 `{"` 就截断再 `cleanProse`，所以助理正在写的 JSON 指令永远不会漏到气泡里。实测首字约 1.5 秒出现。
- **输入框不再锁**：`Composer` 的 `disabled` 只跟「有没有可用会话」有关，忙时按钮文案变「插一句」。

## 员工能做什么

每个员工都是一个真实的 DSH 子 agent，用的是当前的默认模型，工具和你自己一样全。五个能力开关在员工编辑面板里（默认全开）：

- **看图**：`read_image` 打开图片、截图。能不能真的看，取决于当前模型在 DSH 模型清单里有没有声明 `input: [text, image]`；没声明时 DSH 会直接拒绝读图（报 “does not declare image input”），跟模型本身有没有视觉能力无关。这台的 `cszx` 清单已经给 DeepSeek-V4.1-Flash 系列补上了这条，测过能读图里的文字。
- **操作电脑**：`computer_screenshot` 截屏，`computer_click / move_mouse / keypress / type / scroll` 操作，每步之后重新截图确认。已实测可用。
- **联网**：`web_search` / `web_fetch`。
- **定时**：`schedule_create` 建提醒，不用 sleep 死等。子 agent 的提醒只活在它那一轮会话里，需要跨天重复的活就用「重跑」。
- **记忆**：`manage_memory` 写长期记忆，`hindsight_*` 查历史决策。

关掉某一项，员工的行为准则里就不会出现这条，模型也就不会去用。

**改文件要授权**：员工可以在自己的工作目录（`.milancat/work/<部门>/<姓名>/`）里随便写；要动这个目录之外的文件（桌面、文档、下载、别人的项目）、要删除或覆盖任何东西，都得先跟你说明白改什么、等你同意——这条写在每个员工的行为准则里。读文件不受限制。

## 运行时模型：谁在什么时候开 agent

以前的做法是「每说一句话就开一个 agent」，用久了会话窗口里会堆一串子 agent（装在别人机器上时反馈最多的就是这一条），内存和界面都难受。现在改成三层：

1. **助理层不开 agent**。`assistantTurn` 直接用 `ctx.get('llm').stream()` 调模型，不带工具、不建会话、不出现在任何会话列表里；正常一条回复约 2 秒（改前同一句 5.4 秒，多出来的 3.4 秒全是 agent 脚手架的固定开销）。只有在流式调用不可用时才退回 `runAgent` 兜底。
2. **员工层才是真 agent，但由一个插件专属的 root 托管**。`ensureBotRoot()` 用 `ctx.get('agents').create({sessionId:'botroot_…', meta:{cwd, agentPreset}, agentOptions:{provider, model}})` 建一个只属于插件的根会话（**不是**你的对话会话，所以不会出现在你的会话列表里），所有员工都是它的子会话；每干完一件活立刻 `subagents.drainChildren(parent.id, [childId])` 把运行句柄释放掉（下一件活再从磁盘恢复，见第 3 条），缓存 30 轮后整个 root 换新的。`GET /bot/api/diag` 里 `sessions.subagent` 应该是 0——那就是「没有泄漏在用户的对话里」的硬证据。
3. **一个员工 = 一个 agent（0.6.0）**。`startActivation` 的 `childId` 确实不能复用（第二次报 `subagent "x" already exists`，`dispose()` 之后也一样），但那是「再开一个」的路子；真正的复用是 `subagents.sendMessage(parent, childId, content, {signal})`——运行中的目标在下个 step 边界收下，空闲的目标直接起一轮，**已经被释放的目标会从持久化里冷恢复同一个会话**。所以：员工第一次干活时开一个子会话，把 `childId` 记在员工档案的 `agentSessionId` 上；以后这个人的所有活（拆分、执行、补充、汇总）都发进同一个会话。实测同一个员工连做三件活，`botRoot` 子会话数一直是 1，第三件还能准确说出前两件写了哪两个文件——因为它拿到的是自己的全部历史，不是一页摘要。
   代码：`memberOf()` / `saveMemberSession()` / `lastSeqOf()` / `readChildTurn()` / `rememberAnswer()`，`runAgent({…, memberId})` 先走复用分支（`sendMessage` + 读该会话 `assistant/message` 到 `turn/end`），失败就把坏掉的 id 清掉、退回新建并记一条 `reuse-fail`。
   并发派活有个坑：两件活同时派给**同一个人**时，两边都会看到「还没有会话」而各自新建一个，这个人就被裂成了两个 agent（实测过）。所以 `lockMember(memberId)` 按成员排队——第二件等第一件说完，再进同一个会话。诊断可看 `.milancat/reuse.log`（`check` / `NEW` / `FAIL` 三类行，超过 128KB 自动清空）。
4. **释放 + 磁盘记忆双保险**。每轮 `drainChildren` 释放句柄，所以「同时活着」的 agent 数只等于「此刻在干活的人数」；会话本身留在磁盘上，是身份与上下文的载体。另外每个员工目录里的 `记忆.md` 仍然保留：开工前读最近 1400 字注入提示词，收工后追加一行「日期 时间 标签：结论前 160 字」，超过 14KB 裁到 10KB——换机器、删会话之后它还在。总计 agent 数的上界是「员工人数 + 1」，与用多久无关。

### 沙箱 cwd 的坑（改代码前先读）

员工的 shell 一开始全军覆没，报 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(E:\DSH工作区\.milancat)`：DSH 的沙箱要在会话工作区上补一条写权限 ACE，而工作区根目录上有一条继承下来的 `Everyone:(DENY)(DC)`，任何子目录都改不了自己的 DACL，所以 **cwd 选在工作区子目录里的会话，命令行起不来**（文件读写还正常，只有 shell 需要 grantWrite）。

实测对比：同一个子 agent，`cwd=E:\DSH工作区` 时 `echo hi123` 秒回；`cwd=E:\DSH工作区\.milancat` 时 110 秒后回来一条 `grantWrite(...) Win32 5`。所以现在 `botWorkspace()` 一律把 agent 的沙箱目录钉在老板的工作区根上，员工真正干活的目录（`.milancat/work/<部门>/<姓名>/`）写在提示词里：「你的工作目录是 X：文件写在这个目录里，命令也在它下面跑」。`agents.create` 的 `meta.cwd` 和 `startActivation` 的 `request.cwd` 都必须是这个根。

另外两件同一批改的事：所有子 agent 共用**一个** 900ms 的 trace 轮询定时器（原来每个 child 一个 `setInterval`，人多时定时器比活还多）；面板轮询在 `assistant.busy` 时改成 400ms（原来固定 2.2 秒，等于给每条回复白加最多 2.2 秒的「看起来慢」）。


## 界面：浅银灰 + 明亮蓝（0.5.0）

外观按设计稿重做，**行为与数据结构零改动**。要点：

- 72px 深灰银导航条（七个内联 SVG 图标 + 底部运行计数与 `M` 字标），其余仍是「导航 + 248 列表 + 主区」，**助理页例外：不渲染列表列**，把空间让给对话。
- 能力设置从卡片改成右侧 360px 抽屉（遮罩、Esc/点外关闭、Tab 焦点循环、关闭后焦点回到触发按钮）。
- 你的是浅灰蓝气泡，助理的是纯文字块 + 27px 头像（不再是气泡），长回答按 1.95 行高排。
- 任务列表状态写成「部门 · 进行中 · x 小时前」，圆点只是辅助。
- 响应式用**容器查询**（`container-name: dbot`），不跟浏览器窗口而是跟面板宽度走：900/800/640/520/480/400 六档，导航 72→64→54、头部 68→62→59、内边距 28→20→16→14，320px 无横向滚动。
- 全量 token 化：`.dbot-root` 里的 `--dbot-*`（`#F6F7F9` 画布 / `#E9ECF1` 导航 / `#EEF1F5` 列表 / `#1465E9` 强调 / `#1D6AE8→#1255D1` 发送按钮 / `#C33947` 危险）；
- 无障碍：`:focus-visible` 2px `#1465E9` 焦点环（offset 3px）、开关用 `role="switch"` + `aria-checked`、图标一律 `currentColor` 的内联 SVG（不再用 `＋` `×` 字符当图标）、`prefers-reduced-motion` 下关动画、过渡统一 140ms。
- **输入框不画焦点环**：`.dbot-root :focus-visible` 只给 `button` / `[role=switch]` / `select` / `a`，`textarea` 与 `input` 显式 `outline:none`；`.dbot-composer:focus-within` 也不再改边框色、不再加 2px 外圈（原来点进输入框会出现「双层蓝框」，外层是 composer 的 focus-within，内层是全局 `:focus-visible`）。
- **清空聊天记录**：`POST /assistant/clear` 只清 `assistant.messages` / `live` / `inbox`，并复位 `busy`、清 `SHARED.typing`；组织、任务、部门群、上传文件都不动。入口在能力设置抽屉底部的浅红文字按钮（`window.confirm` 二次确认）。

验证方式（没有浏览器可用时的替代）：`node --check` + 自写的无头渲染器（假 React + 假 DOM 加载 `client.js`，灌真实形状的示例状态，逐个实例化组件）。六个 tab 全部渲染 0 异常，覆盖 17 个组件；另用脚本核对 JS 里 123 个 `dbot-*` 类名在 CSS 里都有定义、CSS 括号 253/253 配平、0 个 `U+FFFD`。

修过的一个真实布局 bug：定时页「时间」行曾把 `input[type=time]` 和「每天」下拉**并列塞进两列网格**（`grid-template-columns:92px 1fr`），第三个孩子换行落到标签列下方，看起来像错位。修法是把两个控件包进 `.dbot-inline` flex，网格只留「标签 + 控件」两项；顺带 `.dbot-kv` 的 `align-items` 由 `baseline` 改 `center`，并用脚本审计了全部 7 处 `.dbot-kv`，孩子数都是 2。

## 组织落盘：一个说「建好了」其实没存的 bug（0.5.2）

`applyOrgSpec(state, spec)` 只改传进去的那个对象，**自己不写盘**。0.5.1 之前 `assistantTurn` 拿到 spec 后直接 `applyOrgSpec(s, spec)`，随后又在收尾处 `const s3 = readState(root)` 重新读盘、写回——那次重读不带新部门，于是：助理回复「架构搭好了」、✅ 行也列出七个部门二十个人，但 `state.json` 里一个都没有，组织页永远是空的。

修法（`lib/engine.js`）：
- `applyOrgSpec` 之后立刻 `writeState(root, s)`，在任何人再碰 state 之前落盘；
- 同一处顺手 `ensureGroup(s, dept)`，**建部门就把群建出来**，不用等第一次派活；
- `GET /state` 加自愈：发现某部门没有对应群就补一个并写盘（老数据、朋友的机器都不用重装重导）；
- 群仍然只存 `deptId`，部门改名不影响。

教训：任何「读 → await 模型 → 再读 → 写」的流程，凡是中间只改了第一份对象，就必须在 `await` 之前写盘，否则收尾那次重读+写会静默丢改动。

## 干完的活由助理汇总回报（0.6.1；0.5.3 曾被写成「每个部门自己冲进来汇报」）

任务列表写「完成」、助理那栏静悄悄，是错的：真实公司里没人交完活就算完，结论要回到老板桌上。

- 但**汇报的人应该是助理，不是部门**。0.5.3 的写法是每个部门自己往 `assistant.messages` 里塞一条署名「XX组·汇报」的消息——几个组同时干活，老板就会收到一串消息，等于把所有员工叫到老板面前挨个汇报。0.6.1 改成：`reportTask()` 只打 `t.reported` 标记，然后 `scheduleReports()` 攒 2.5 秒，`flushReports()` 把这一批（可能好几件）交给一次 `askModel`，用 `PERSONA_ASSISTANT` 的口吻说 1–3 句，只写进一条 `assistant.messages`（无 `author`，就是「助理」），再 `feishuPush`。模型没答出来时有兜底模板，也不会冒出员工名。
- 老板正在跟助理说话时（`assistant.busy`）不插队，等这一轮说完再汇报；`task.reportedToBoss` 保证不重发，「重试」时和 `reported` 一起清零。
- 升级迁移：`readState` 里有一段一次性 `reportMigrated`，把 0.6.0 及以前「已汇报过」的老任务标成 `reportedToBoss = reported`——否则升级后会把这些历史任务当成待汇报，一次性全倒给老板（开发时就撞到过，两条聚合消息把早报、小红书全复述了一遍）。
- 幂等与补账：`POST /tasks/<id>/report`（任务详情右上角「让助理汇报」）仍然可用，走的也是这条汇总路径。
- 助理上下文里的 `finishedDigest(state)`：最近 6 件做完的活，带 240 字交付摘要和 id。所以问「那篇写完了吗」它照着答，不需要工具。
- 顺带修掉一个真实事故：助理曾把 `<||DSML||calls>` / `invoke name="computer_screenshot"` 当成正文吐给老板。助理层**没有工具**（`llm.stream` 直连），这类块只能来自模型幻觉，所以 (a) `PERSONA_ASSISTANT` 明写「你没有任何工具，不要输出工具调用语法」；(b) 新增 `stripDsml(text)`，在 `cleanProse` 入口统一清掉成对/半截块；(c) 存量消息一次性清洗。

## 飞书入站：三条真实报错分别意味着什么（0.5.4）

2026-11-08 在一台真实机器上把飞书打通了，过程中踩到三个各自独立的坑，全部写进代码：

1. **`230002 Bot/User can NOT be out of the chat` —— 机器人根本没进群。** 飞书界面里"能看到这个机器人"和"这个应用是群成员"是两件事；`lark-cli im +chat-list --as bot` 返回 `chats: null` 就是没进（`+chat-list` 的 `--params` 不支持 `--chat-id`，必须走 `--params @params.json`，且 JSON 文件不能带 BOM，否则报 `--params invalid format`）。补进群：`lark-cli im chat.members create --params @p.json --data @d.json --as user`，参数 `member_id_type: app_id`，body `{"id_list":["cli_xxx"]}`。
2. **`230027 access denied` —— 在群里，但应用缺 `im:message:readonly`。** 新建的应用默认只有发消息的能力，`im +chat-messages-list --as bot` 会一直被拒。不必去开放平台加权限发布：本机的**用户 token** 本来就在这个群里，读得到。`readPage(f, chatId)` 因此先试 bot、失败再试 user，成功的那一个记在 `f.pollAs`（日志 `poll identity: user`）；`feishuPush` 永远用 bot 发。分工＝**你本人读，机器人发**。
3. **`another event bus is already connected`（`online_instance_cnt=1`）—— 长连接被占。** 飞书一个应用只允许一条长连接，同一个应用在另一台电脑上开着就会互斥（本机 `lark-cli event status` 显示 Bus 未运行仍会报这个，说明占用方在别处）。通道自动降级 `POLL_MS = 1500` 轮询，功能一致。

顺带修掉轮询里两个形状问题：`im +chat-messages-list` 返回的 `content` 已经是**解码后的纯文本**（不是 `body.content` 里的 JSON），旧 `messageText()` 一律返回空串，等于永远读不到话；`create_time` 是 `2026-11-08 17:56` 这种本地墙上时间，`Number()` 得 `NaN`，排序和去重都失效。新增 `msOf(item)` 统一成 epoch 毫秒，并加了「早于本次绑定 5 秒的历史不回复」的护栏（`--start` 可能被 CLI 当本地时间解释）。

实测：手机飞书发一句 → 14 秒内助理在群里回话（`user` 气泡 → `app`「收到，助理开始处理」→ `app` 正式答复），面板里同时出现同一段对话。

## 一直在弹黑色命令行窗口（0.5.5）

轮询一开，屏幕上每 1.5 秒闪一个黑框——根因在 `lark-cli` 自己的启动方式：`scripts/run.js` 只是个 shim，它用

```js
execFileSync(bin, args, { stdio: "inherit" })   // ← 没有 windowsHide
```

去拉起 `bin/lark-cli.exe`（原生控制台程序）。DSH 是 GUI 宿主，本身没有控制台，所以这个孙进程每被拉起一次，Windows 就给它分配一个**新的可见控制台窗口**——父进程的 `windowsHide: true` 管不到孙进程。

修法：`lib/feishu.js` 里新增 `CLI_BIN` / `cliInvocation()`，**直接调用原生二进制**（存在就用它，不存在才退回 `node run.js`）：

```js
const CLI_BIN = join(NPM_DIR, 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe')
function cliInvocation(args) {
  if (CLI_BIN && existsSync(CLI_BIN)) return { file: CLI_BIN, argv: args }
  return { file: process.execPath, argv: [RUN_JS, ...args] }
}
```

`larkRun()` 与 `event consume` 的 `spawn` 都走它，全部带 `windowsHide: true`；只剩一个进程、且被要求隐藏，窗口不再出现。日志里会写一行 `cli exec: native …lark-cli.exe` 作为证据。

## 用你自己建的机器人说话（0.5.6，直连 Open API）

0.5.5 及以前的致命误会：收发**全部**走这台电脑上 `lark-cli` 登录的那个应用。你把**自己建的**机器人拉进群、也发消息，看着像通了，其实回话的是那个已登录的应用（换台机器 / 换个账号登录，机器人就换了个人）。0.5.6 起面板里可以填自己的凭据：

```
POST /feishu/app { appId: "cli_…", appSecret: "…" }
  → verifyApp() 换 tenant_access_token 并 GET /im/v1/chats
  → 200 说明「凭据对」且「这个机器人在群里」
```

- **发送**：`sendText()` 优先 `directSend()`（`POST https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`），身份必然是 `appId` 对应的机器人；只有直连失败才回退 CLI。
- **接收**：`readPage()` 先试直连（`GET /im/v1/messages`）；缺 `im:message.group_msg` 会得到 `230027`，此时退回 CLI 的 user 身份（你本人在群里），功能一致。被拒的探测会记 60 秒，不会每 1.5 秒打一次注定失败的请求。
- **凭据只进不出**：`engine.pubFeishu()` 把 `appSecret` 统一替换成 `••••••`，`/state`、`/feishu`、`/feishu/app`、`/feishu/test` 全部经过它（这一条是补的：早前 `/feishu/test` 会把明文 Secret 回给浏览器）。
- 想彻底不启进程：开放平台 → 你的应用 → 权限管理勾 `im:message.group_msg` → 创建版本并发布。之后「机器人能自己读群消息」那条自检变 ✅，日志写 `poll identity: direct app`。

## 界面默认是安静的

执行过程（调了什么工具、读到什么）**默认不显示**，只给结果——给普通用户看的是「他说了什么、做完没有」，不是 agent 的思考流水账。想看过程：助理页右上角「能力设置」→「显示执行过程」打开，之后每条回复下面会出现「过程 · N 步」可展开；这个开关存在 `state.json` 的 `ui.showTrace`，重启也记得。任务详情页里的步骤永远显示——那个页面本来就是用来看过程的。

## 手机派活：接飞书

电脑开着、DSH 开着，你在外面用手机飞书就能给同一个助理派活，结果也回到飞书里——**面板和飞书共用同一份对话**，不是两个机器人。

1. 面板左侧点「飞书」页。
2. **最省事的路子：点「让助理带我接」。** 助理会自己跑 `lark-cli auth status`、`lark-cli im +chat-list --as bot` 量一遍机器，看看到底卡在哪一步，然后一次只让你做一件事（先权限、再建群、最后绑定），你说做完了它会重新测一遍再进下一步。全程不需要你粘 App Secret，也不需要你手抄 chat id——它拿到群 id 会自己绑。
3. 面板上那张「接线自检」卡片是随时可看的状态：`lark-cli 装好` / `机器人身份` / `权限` / `机器人在群里` / `面板绑定` / `通道在跑`，哪一条打 ⬜ 就是当前卡点，下面直接写「怎么过这一步」。
4. 想自己动手也行：
   - 飞书开放平台 → 这个应用 → 权限管理，开 `im:message`、`im:message:readonly`、`im:chat:readonly`，然后创建版本并发布；
   - 在飞书里建一个群（比如「总裁办」），群设置 → 机器人 → 添加 `milancat bot`（也可以直接在飞书里搜它、私聊发一句，同样会出现）；
   - 回面板点「刷新机器人所在的群」，点那个群 → 自动绑定并发一条欢迎消息。
5. 之后在群里说话（@ 机器人更稳），助理会把回答发回群；面板里同一条消息会标「来自飞书 · 手机」。

实现上：主机侧常驻一个 `lark-cli event consume im.message.receive_v1 --as bot` 子进程收事件，收到消息就当作一轮助理对话（和面板共用 `state.json` 的 `assistant.messages`），回答通过 `lark-cli im +messages-send` 发回同一个群。通道日志在 `<工作区>/.milancat/feishu.log`。

**长连接被占用时自动降级为轮询**：飞书对同一个应用只允许一条长连接（报 `another event bus is already connected to this app`）。这种情况下通道会自己改用 `im +chat-messages-list` 每 3 秒拉一次群历史，面板的「通道进程」显示「运行中 · 轮询兜底」，功能一样，只是延迟几秒，也不再需要事件订阅权限。

## 数据放在哪

- 组织、任务、群聊、助理对话：`<工作区>/.milancat/state.json`（旧目录 `.dsh-bot` 会在首次启动时自动迁移）。
- 每个员工的工作目录：`<工作区>/.milancat/work/<部门>/<员工>/`。
- 头像：`<工作区>/.milancat/avatars/`。
- 你发的文件、图片：`<工作区>/.milancat/files/in/`，索引在 `files/index.json`。

备份就备份 `.milancat` 整个目录。

## 已知边界

- **不是每 agent 一台电脑**。所有员工共享这一台机器和你的账号权限，所以派活前想清楚哪些事不该让它们碰（例如动生产环境、发消息给真人）。要隔离只能靠「别装这个插件」或单独开一个 DSH profile。
- 同时最多 3 个任务在跑，每个任务里最多 2 个员工并行，单个任务 45 分钟超时。
- 子 agent 不会出现在你的会话列表里，它们跑完就消失；要看过程只能看任务的步骤流水。
- 看图能力受当前模型限制（见上）。

## 排错

| 现象 | 处理 |
|---|---|
| 左侧栏没有图标 | 重开 DSH；确认 `plugin_manager list_bundles` 里能看到，且没有 disabled |
| 面板空白 / 一直转 | 刷新页面；`GET /milancat/api/ping` 应返回 `{"ok":true}`（旧版是 `/bot/api/ping`，两个都可用） |
| 派活后一直「排队中」 | 有 3 个任务在跑，等一个结束；或看 `/milancat/api/diag` 的 `running` |
| 员工不动手 / 说没权限 | 检查它的能力开关，以及该任务的工作目录是否在工作区内 |
| 中文变乱码 | 这个仓库的文件必须用 UTF-8 编辑器改，别用 PowerShell 的 `Get-Content`/`Set-Content` 重写 |

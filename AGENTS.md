# 仓库约定

面向在本仓库工作的自动化助手与贡献者。只收录「必须这样做，否则会出错」的规则，不重复 README 里已有的使用说明。

## 分支与推送

- 远端**只有一个分支 `main`**，它同时也是默认分支。核实方式：

  ```sh
  git ls-remote --symref origin HEAD   # -> ref: refs/heads/main
  git ls-remote --heads origin         # -> 仅 refs/heads/main
  ```

- 推送一律用 `git push origin main`。**不要**写成 `main:master` —— 该写法基于「本地 main 对应远端 master」的旧假设，现已失效，会新建一条不该存在的分支。
- 推送前先看 `git status -sb`：确认是 `## main...origin/main`，暂存区只包含本次改动，没有误入的生成物。

## 提交信息

- 中文 conventional commit：`type(scope): 简述`。
  type 取 `feat` / `fix` / `perf` / `i18n` / `build` / `chore` / `docs`；scope 用包名（如 `airoha-npu`）或 `repo`。
- 正文写**为什么**，不要复述 diff。涉及实测数值（寄存器取值、吞吐、中断数、md5）时把数值写进正文，方便以后判断该结论是否已经过期。
- 一次提交只做一件事，不混入无关的格式化改动。

## 不入库的内容

- `.workbuddy/` 是本机助手工作区（项目记忆、临时脚本、截图），已在 `.gitignore` 中忽略，不要 `git add -f` 强行加入。
- 手工部署到测试机时的压缩产物、`.lmo` 等生成物不回写仓库；仓库只保存源码与 `po`。

## 前端与 i18n 的硬约束

- LuCI 视图模块开头的 `'require view';` / `'require view.airoha.ui as aui';` 是**加载器的依赖声明**，不是无副作用的字符串。压缩时 **`compress` 必须关闭**：terser 会把这些语句当死代码删掉，`rpc` / `aui` 全部未定义，页面报 `rpc is not defined` 并整页白屏。
  只允许这一组选项：

  ```js
  { parse: { bare_returns: true }, compress: false, mangle: false,
    format: { comments: false, quote_style: 3 } }
  ```

  `parse.bare_returns` 因为模块顶层是 `return view.extend(...)`；`quote_style: 3` 保留原始单引号。
- 新增或修改 `_()` 词条时，`po/templates/*.pot` 与 `po/zh_Hans/*.po` 必须**同时追加到文件末尾**，两份 `msgid` 集合保持一致（顺序可以不同）。
- 手工部署到设备时，改完 `po` 必须重建 `.lmo` 并单独放到 `/usr/lib/lua/luci/i18n/`，否则新词条回落到英文。

## 部署与打包分离

- 仓库是 `feeds` 源码，构建由 OpenWrt/ImmortalWrt 的 `luci.mk` 完成；不要把目标机上的部署结果（压缩后的 js、生成的 lmo）提交回来。
- 手工部署到测试机属于验证手段，不改变仓库内容；验证结论写进提交正文或 issue，不要写成仓库内的临时文件。

# dshm-tool-indexquery（AI 生成，个人自用）

> For personal use only. AI-generated. If any infringement, will delete immediately.

把本机已有的**教材页级索引**暴露成 DeepSeek Harness（DSH）模型可见的两个工具，用于“先定位、再回读”，减少检索类工具调用与 token 消耗。

- `index_query(keyword, book_id?, limit?, context_chars?)`：检索命中页，只返回命中段落，不整页打印；
- `index_page(book_id, pages)`：按 PDF 页范围回读整页文本（单页有字数上限）。

插件**不携带任何教材 / 指南正文**，只读用户本机已建的索引目录；**不联网、无遥测、不上传任何数据**。

目录为**扁平结构**（`index.js` 在包根，方便 GitHub 网页直接上传，不需要 `lib/` 子目录）。

## 状态（如实写）

- 代码为 AI 生成，**已在 DSHM 端侧验证可用（2026-10-23）**：`index_query`（FTS 与 1 字词 LIKE 两路）与 `index_page`（按 PDF 页码回读）实测通过；未做完整 `node --check`（本机无 node），实际验证以装载为准。
- 只在宿主 Node 上运行；依赖 Node 内置 `node:sqlite`（Node ≥22.5；本机 v24 满足）。`node:sqlite` 不可用或缓存缺失时自动退回 JSONL 扫描，两路返回字段一致。
- SQLite 结果按“前 400 个命中页内排序”截断；JSONL 回退走全量扫描（较慢）。单页回读上限 4000 字。

## 安装（DSHM 端侧）

1. 把本目录整体拷到：

   ```
   $DSH_HOME/profiles/ondevice/node_modules/dshm-tool-indexquery/
   ```

2. 在用户层 patch（`$DSH_HOME/cordis.patch.yml`）末尾追加：

   ```yaml
   - insert:
       - id: tool-indexquery
         name: dshm-tool-indexquery
         config:
           indexDir: /storage/Users/currentUser/deepseekstation/doctorplace/索引/页
   ```

   - `indexDir`：`索引/页` 目录（必填）；同级的 `页索引.db` 与 `书目.json` 自动发现。
   - `dbPath`：可选，显式指定 SQLite 缓存路径。

3. 重启 DSHM（profile `patchReload: startup`，不重启不生效）。

4. 验证：新会话里问一句“用 index_query 查 慢性肾脏病”，应返回《内科学》p.57 等命中页与段落；再用 `index_page` 回读 p.57 核对原文。

**停用 / 回退**：给该行加 `disabled: true`（或删掉该行）并重启，不影响其他插件与工具。

## 工具参数

| 工具 | 参数 | 说明 |
|---|---|---|
| `index_query` | `keyword`（必填） | 检索词；英文不区分大小写，≥3 字走 FTS trigram，否则 LIKE |
| | `book_id` | 只查单本 / 单分卷（见 `索引/书目.md`） |
| | `limit` | 返回页数，默认 8，最大 20 |
| | `context_chars` | 命中词前后各取多少字，默认 100，最大 400 |
| `index_page` | `book_id`（必填） | 目标书 / 分卷 |
| | `pages` | PDF 页码：`57`、`57-58`，逗号分隔多段；单次最多 10 页 |

输出字段：`book_id / title / edition / pdf_page / book_page / score / segments`（`index_page` 为 `pages[].text`）。`book_page` 为 0 表示该页识别不到印刷页码。

## 法律与合规提示

- **版权**：本仓库/插件不包含任何教材、指南全文或索引数据；运行时只读取用户自行合法取得并已在本地建好的索引。输出仅为检索定位碎片，使用者应自行回原文核对；不得用本工具批量复制、传播受版权保护的正文。
- **医疗免责**：本插件是检索辅助工具，不是医疗器械，不提供诊断、治疗或用药建议；任何临床决策由执业医师基于原文与指南作出。
- **个人数据**：不采集、不联网、不上传；无遥测、无分析埋点。
- **商标**：DeepSeek、DeepSeek Harness（DSH）等名称仅作描述性使用，不代表官方认可或关联。
- **开源合规**：MIT 许可；无第三方运行时依赖（只用 Node 内置模块）。

## 已知限制

- 尚未真机验证；`node:sqlite` 的 `readOnly` 打开方式失败时会退化为普通只读查询（`PRAGMA query_only`）。
- FTS trigram 对 1～2 字词不生效（走 LIKE，可能较慢）。
- `index_page` 单页截断 4000 字；表格/跨页内容仍需回原书核对。
- 索引需要先由既有工具（`indexquery.py` 体系）建好；本插件不建索引、不改索引。

## 开发

```bash
node --check index.js   # 语法检查（无需依赖；本机无 node 时跳过，按「状态」如实标注）
```

无构建步骤、无运行时依赖；改完移植到 profile `node_modules` 并重启即可。

## 许可

MIT，见 `LICENSE`。

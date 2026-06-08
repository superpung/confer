<div align="center">

<img src="web/public/favicon.svg" width="64" alt="confer" />

# confer

**where research convenes ｜ 研究在此汇聚**

一个快速、可搜索的论文聚合站，把顶级会议与期刊的录用论文收拢到一处——
纵览整个领域、追踪作者与机构，把论文读成洞见。

[English](README.md) · **中文**

[**打开在线站点 →**](https://confer.repus.me)

</div>

---

## confer 是什么？

每个会议、期刊都把录用论文发布在各自的网站上，格式各不相同。**confer** 把它们
汇聚到同一个界面里——几分钟就能扫完一个领域，而不必在十几个 program 页面之间
来回点击。

它是一个静态网站，背后是一条轻量的抓取流水线：每个会场都被归一化成同一套
`Paper` 数据结构，再从书目与开放元数据源补全 DOI、摘要、出版信息和开放访问链接。
无需账号、没有后端——你的收藏和已保存搜索都存在浏览器本地。

## 亮点

- 🔎 **字段化搜索。** 直接输入是全局搜索，也可用前缀限定范围：
  `author:"Jane Doe"`、`title:routing`、`inst:"MIT"`、`track:…`、`abstract:…`。
  多个词是「与」，短语用引号。
- 🏷 **作者与单位。** 悬停作者即可看到其所属单位；点击单位可列出该单位的全部论文。
- 📊 **Insights 面板。** 针对当前筛选结果，实时展示 Top 机构 / 作者 / track 的图表，
  点击任意条形即可下钻筛选。
- ⭐ **收藏与已保存搜索。** 跨会场收藏论文；保存一组筛选条件以便日后回到。
- 📤 **导出。** 当前结果可一键复制 BibTeX 或下载 CSV，包含 DOI 与出版元数据。
- ⚡ **快且私密。** 单页预渲染，所有筛选都在客户端完成。支持深/浅色、
  键盘快捷键（`⌘K`、`⌘/`）以及移动端响应式布局。

## 收录会场

confer 目前汇聚了 EDA、计算机体系结构、软件工程、软件测试与程序语言领域的
会议和期刊——**DAC、DATE、ASPLOS、HPCA、ISCA、MICRO、ICSE、FSE、ASE、
ISSTA、TOSEM、TSE、OOPSLA、POPL、PLDI**——新增会场只需改配置。在分类侧边栏中
即可浏览全部。

## 工作原理

```
config/venues.yaml ─▶ 抓取器 + 元数据补全 ─▶ 每个会场一份归一化 JSON ─▶ Astro 站点 ─▶ 静态托管
```

- **配置**列出会场、主抓取适配器，以及可选的元数据补全源。
- **适配器**各自只懂一个来源平台，但都产出*相同*的 `Paper` 结构。
- **补全器**合并 Crossref/OpenAlex 元数据，例如 DOI、摘要、出版日期、卷期页码、
  关键词，以及开放访问 / PDF 链接。
- **站点**只消费归一化后的数据——新增会场永远不动 UI。

架构、`Paper` schema 与适配器约定详见 **[AGENTS.md](AGENTS.md)**。

## 本地运行

**生成数据**（Python，使用 [uv](https://docs.astral.sh/uv/)）：

```bash
cd scraper
uv run confer list                      # 查看已配置的会场
uv run confer build                     # 构建所有启用的会场 → web/public/data/
uv run confer build --venue icse2026    # 只构建某一个会场
uv run confer build --refresh           # 忽略缓存，重新联网抓取
```

每个会场缓存在 `data/cache/<venue_id>/`，因此非 `--refresh` 时离线即可重跑。

**运行站点**（Astro，Node ≥ 18）：

```bash
cd web
npm install
npm run dev        # 本地开发服务器
npm run build      # 静态构建 → web/dist/
```

站点在构建时读取 `web/public/data/`，产出静态的 `dist/`，可托管到任意静态主机。
已提交的 JSON 即构建输入，所以部署时只跑 Astro 构建——部署阶段不需要 Python。

## 新增会场

1. 在 `config/venues.yaml` 增加一项（字段在文件内有注释说明）。
2. 把它的 `scraper:` 指向已注册的适配器（`dateconf`、`dblp`、`linklings`、
   `researchr`、`sigarch`）。
3. 当主来源缺少出版元数据时，配置 `source.enrichers`（`crossref`、`openalex`）。
4. `uv run confer build --venue <id>`，检查 `web/public/data/<id>.json`。

要支持新平台，在 `scraper/src/confer/scrapers/` 下新增一个适配器并注册——
详见 AGENTS.md「How to add a scraper adapter」。

## 致谢

由 [Super Lee](https://github.com/superpung) 与 [Claude](https://claude.com/product/claude-code) 共同打造。

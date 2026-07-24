# 柱子软考智能备考 V3.5

完全运行在 GitHub Pages 上的静态备考系统，不需要服务器、数据库或账号登录。

## 本版功能

- 300 道选择题，含概念题、情景题和计算题
- 10 道案例简答题关键词检查
- 自适应练习、随机练习、章节专项、计算专项和全真模拟
- 1 / 3 / 7 / 14 / 30 天错题间隔复习
- 收藏题、个人笔记、错因标记
- 章节掌握度、历史成绩和错因统计
- 固定试卷分享链接，同一链接题目顺序一致
- 成绩海报生成
- PWA 安装、离线刷题、自动版本检查
- 浏览器本地学习数据导入与导出
- 静态题库管理工具 `admin.html`
- GitHub Actions 定时检查、校验、条件合并题库并部署

## 文件结构

```text
index.html                 学习系统入口
admin.html                 浏览器本地题库管理工具
css/app.css                页面样式
js/app.js                  主要功能
js/storage.js              学习记录与旧版迁移
js/admin.js                题库管理工具
data/questions.json        300 道选择题
data/cases.json            案例题
data/formulas.json         公式卡
data/version.json          版本和更新说明
manifest.webmanifest       PWA 配置
sw.js                      离线缓存和更新
scripts/                   自动校验与合并脚本
incoming/                  候选新题目录
.github/workflows/pages.yml 自动更新与部署
```

## 部署到现有仓库

1. 先下载并解压升级包。
2. 在 GitHub 仓库中备份当前 `index.html`。
3. 将升级包内的全部文件和文件夹上传到仓库根目录，覆盖旧文件。
4. 打开仓库 **Settings → Pages**。
5. 在 **Build and deployment → Source** 中选择 **GitHub Actions**。
6. 打开仓库 **Actions**，等待“校验题库并部署 GitHub Pages”运行成功。
7. 用原网站地址打开，并在首次更新时刷新一次。

## 自动更新题库

把人工审核过的 JSON 文件上传到 `incoming/`。工作流会：

1. 检查结构、ID、选项、答案和重复题。
2. 只有累计达到 10 道有效新题才正式合并。
3. 自动更新 `data/questions.json` 和 `data/version.json`。
4. 把已处理文件移动到 `incoming/processed/`。
5. 自动重新部署 GitHub Pages。

工作流还会在每周日北京时间 11:17 定时检查，也可以在 Actions 页面手动运行。

## 本地预览

由于题库已拆分为 JSON，不能直接双击 `index.html`。在项目目录运行：

```bash
python -m http.server 8000
```

再打开 `http://localhost:8000/`。

## 注意

- 学习记录保存在当前浏览器的 `localStorage`，需要定期导出备份。
- 静态版不能实现跨设备自动同步、后台统一收卷和多人排行榜。
- 自动校验只能发现结构和完全重复问题，正式题目仍需人工复核答案、解析和时效性。

# 霍邱·六安招投标信息看板 V1.0

这是一个完全基于 GitHub Pages 的静态看板。

## 已有功能

- 默认重点显示霍邱县、市直区
- 支持六安市各县区切换
- 只收录房建、市政、公路、水利类公开招标工程
- 默认隐藏纯勘察、设计、监理、咨询项目
- 关键词、日期、地区、行业和跟进状态筛选
- 适配评分、预算、截止时间、项目资格摘要
- 收藏、跟进状态和个人备注（保存在当前浏览器）
- 导出筛选结果为 CSV
- 手机桌面安装和离线查看
- GitHub Actions 每天北京时间 09:00 自动更新
- 自动更新失败时保留旧数据，不会把看板清空

## 数据来源

六安市公共资源交易中心公开页面：

- https://ggzy.luan.gov.cn/
- https://ggzy.luan.gov.cn/jysearch.html

投标前必须以原公告、最新澄清和正式招标文件为准。

## 部署

1. 在 GitHub 新建公开仓库，建议命名 `luan-tender-dashboard`。
2. 把本压缩包解压后的全部文件和文件夹上传到仓库根目录。
3. 打开 `Settings → Pages`。
4. 在 `Build and deployment → Source` 选择 `GitHub Actions`。
5. 打开仓库 `Actions`，运行“每日更新并部署招投标看板”。
6. 等待绿色对勾后访问：
   `https://你的用户名.github.io/luan-tender-dashboard/`

## 定时更新时间

工作流中的：

```yaml
- cron: "0 1 * * *"
```

代表 UTC 01:00，即北京时间每天 09:00。

## 调整默认地区

修改 `config.json`：

```json
"defaultRegions": ["霍邱县", "市直区"]
```

## 注意

官方网站结构变更时，自动抓取可能失效。系统会保留旧数据并在 `data/meta.json` 中记录失败原因。

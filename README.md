# 柱子万能工具箱 V1.0

一个仓库、一个 GitHub Pages 地址，包含四个模块：

- `apps/ruankao/`：软考智能备考 V3.5
- `apps/tender/`：霍邱·六安招投标信息看板
- `apps/hotel/`：酒店经营助手
- `apps/engineering/`：工程常用计算

农业模块暂未加入。

## 推荐仓库名

`zhuzi-toolbox`

部署后网址：

`https://5214441.github.io/zhuzi-toolbox/`

## 自动化

根目录只有一个工作流：

`.github/workflows/deploy.yml`

它会：

1. 校验软考题库；
2. 每天北京时间 09:00 更新招投标数据；
3. 将整个工具箱部署到 GitHub Pages。

## 数据隐私

学习记录、收藏、备注、酒店历史记录都保存在使用者当前浏览器的 localStorage 中，不会自动上传到 GitHub。

## 部署

1. 新建一个公开仓库。
2. 上传本压缩包解压后的全部文件和文件夹。
3. 打开 `Settings → Pages`。
4. `Source` 选择 `GitHub Actions`。
5. 打开 `Actions`，手动运行一次“更新并部署柱子万能工具箱”。


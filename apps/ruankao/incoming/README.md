# 候选题目录

把经过人工审核的 JSON 题目文件上传到本目录。文件根节点可以是题目数组，也可以是 `{ "questions": [...] }`。

GitHub Actions 会在以下情况运行：

- 上传或修改 `incoming/*.json`
- 每周日定时检查
- 在 Actions 页面手动运行

默认只有累计达到 **10 道结构校验通过的新题** 才会自动合并。合并成功后，原文件会移动到 `incoming/processed/`，并自动更新 `data/version.json`。

`*.example.json` 不会参与自动合并。

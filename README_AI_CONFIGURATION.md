# Eastudy 智能服务配置与逐句分析契约

1. 在你的 AI 服务商控制台创建 API Key。
2. 在部署平台的 Environment Variables 中配置 `.env.example` 里的三项 `ZOSPEAK_AI_*` 变量。
3. 控制端“系统设置 → 智能服务连接”保存当前浏览器的连接草稿；正式部署由服务端 Adapter 读取环境变量。
4. Beta 6.10 把学习分析固定放在控制端生产链路：`上传 → WhisperX → 翻译 → 词汇 → learning_analysis → 人工复核 → 发布`。
5. `learning_analysis` 必须逐句返回与原句完全对应的数据，学员端只读取结果，不在播放时临时请求模型。

推荐的服务端 Adapter 返回结构：

```json
{
  "videoId": 2805,
  "title": {
    "en": "How I Start My Day in the English Countryside",
    "zh": "我在英国乡村如何开始一天"
  },
  "sentences": [
    {
      "id": "2805-3",
      "english": "And I'm taking you with me to get it done.",
      "chinese": "我要带着你一起把它们完成。",
      "keyWords": ["taking you with me", "get it done"],
      "grammar": "am taking 构成现在进行时；to get it done 是目的状语，get + 宾语 + done 表示使某事完成。",
      "confidence": 0.96,
      "requiresReview": true
    }
  ]
}
```

校验约束：

- `keyWords` 中每个单词或短语必须来自当前英文句子，并保持原有词序。
- `grammar` 描述当前句真实出现的时态、句型、从句或修饰关系，禁止写通用占位提示。
- AI 结果先写入 `REVIEW` 状态；运营人员逐句确认后改为 `APPROVED`。
- 中英文标题同时保存；学员端中文界面读取 `titleZh`，英文界面读取 `title`。

API Key 不写入学员端页面、静态 JavaScript 或 Git 仓库。

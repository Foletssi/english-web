# Eastudy 智能服务配置与逐句分析契约

1. 在你的 AI 服务商控制台创建 API Key。
2. 在运行 Worker 的电脑上登录控制端，进入“系统设置 → AI 接口设置”。Worker 2.5.1 在本机 8791 端口提供设置服务；浏览器如提示访问本地网络，请允许。
3. 填写 OpenAI Chat Completions 兼容的 HTTPS 地址（通常包含 `/v1`）、准确模型 ID 和 API Key。普通兼容接口选择“服务商默认”；支持 DeepSeek `thinking` 参数的接口可选择开启或关闭。更换地址时必须填写新密钥。运行“测试翻译与释义”，核对样例后保存。
4. 正式配置保存在 Worker 工作目录的 `settings/ai.json`，密钥由 Windows DPAPI 绑定当前 Windows 用户加密，页面不回显。管理员身份由 Supabase `is_admin` 实时验证。配置对后续任务生效，正在运行的任务使用启动时的快照；未保存配置时继续读取 `ZOSPEAK_AI_*` / 现有 DeepSeek 环境变量。
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

当前链路使用本机 faster-whisper 识别英文；翻译、词汇和逐词语境释义仍保留独立完整复核、音标与覆盖校验。关闭思考不改变语音识别模型，但可能影响复杂语义；样例通过不构成全量语义保证。新接口支持程度与价格由服务商决定，不承诺固定每条视频 1 元。

接口样例测试会产生两次少量模型调用，不上传视频音频。仅接受管理员登录、指定网页来源及回环主机名；密钥不会发送到 Supabase。若需恢复环境变量配置，先停止空闲 Worker，将工作目录的 `settings/ai.json` 改名保留，再重启 Worker。

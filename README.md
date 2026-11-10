# OpenAI 免费模型速查

查 OpenAI 数据共享计划的每日免费 token：哪些模型免费、你的层级每天能用多少、哪些快关停了。一键部署一份到你自己的 Cloudflare 账号，之后它每天自己更新数据，你不用管。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/piscon/openai-free-models)

## 部署只需三步

需要一个免费的 Cloudflare 账号和一个 GitHub 账号，不需要本地环境、不需要任何 API Key。

1. **点上面的按钮**，登录 Cloudflare，确认项目名，点部署（等它跑完，约 2 分钟）
2. **开启你的网址**：进入刚建好的 Worker → *Settings → Domains & Routes* → **workers.dev** 一行点 **Enable**
3. **打开网址**（形如 `https://openai-free-models.<你的子域>.workers.dev`），看到速查页就完成了

就这三件事：**数据不用你维护**（每天自动同步）；**别再点第二次部署按钮**（那会新建一套，不是更新）；**网址打不开**就是第 2 步没开启，回去点 Enable。

其他内容（更新方法、排错、Fork 部署、自定义）都在 **[进阶指南 docs/GUIDE.md](./docs/GUIDE.md)** 里，用到再看。

## 致谢与交流

数据来自 OpenAI 官方公开文档；感谢 [LINUX DO](https://linux.do) 社区的佬们，有问题或建议欢迎到社区找我，或在本仓库提 Issue。

第三方整理工具，与 OpenAI 无隶属关系，最终以官方页面为准。代码 MIT（见 [LICENSE](./LICENSE)）。

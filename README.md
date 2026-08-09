# Toshy - Coding Agent v0.1
[Rivet][riv]-based coding agent for work in VSCode. \
Is in active development. \
Only for Linux now. Do not supports images for now.

## Tools which model can use
- **Remember This** - Save something to model permanent memory.
- **Forget This** - Erase something out of model permanent memory.
- **Search Memory** - Searching model temporary and permanent memory.
- **List memories** - List model permanent memory for user.
- **Lite Web Search** - Parsing short search results straight to model context.
- **Deep Web Search** - Parsing a couple of web pages to model temporary memory.
- **Read URL** - Parsing web page under link to model temporary memory.
- **@File ("Continue" - User usage only)** - Get code from the specified project file.

## Dependencies
- VSCode + Continue (2.0.0)
- Node.js (v18+)
- (Optional) [Rivet][riv]

## Installation
```bash
git clone https://github.com/supertoshibaz/Toshy-Coding_Agent.git
cd Toshy-Coding_Agent
npm install
```

Copy config.yaml contents to your config.yaml ("Continue")

## Using
Start main model at 0.0.0.0:8080 \
Start embedding model at 0.0.0.0:8081 \
Start server.js (node ./server.js) \
You can talk with model in "Continue" chat. Also you can use Ctrl+I to redact parts of code in your project.

[riv]:https://github.com/Ironclad/rivet
